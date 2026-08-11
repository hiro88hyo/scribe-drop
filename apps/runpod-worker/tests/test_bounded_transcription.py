"""Tests for bounded planning, ownership, prompts, and sensitive spooling."""

from __future__ import annotations

import math
import stat
from itertools import pairwise
from pathlib import Path
from typing import Final

import pytest
from pydantic import ValidationError

from scribe_drop_worker.bounded_transcription import (
    CONTEXT_SAMPLES,
    CORE_SAMPLES,
    MAX_DURATION_SAMPLES,
    MAX_NATIVE_TIMESTAMP_PADDING_SECONDS,
    MAX_PROMPT_BYTES,
    MAX_SEGMENT_TEXT_BYTES,
    MAX_SEGMENTS,
    MAX_SPOOL_BYTES,
    MAX_TOTAL_TEXT_BYTES,
    MAX_WINDOW_BYTES,
    SAMPLE_RATE,
    PromptTail,
    RawWindowSegment,
    SegmentSpool,
    SpoolLimits,
    WindowSegmentMerger,
    plan_windows,
)
from scribe_drop_worker.errors import WorkerError

MAX_TEST_PROMPT_BYTES: Final = 16
SECURE_FILE_MODE: Final = 0o600
EXPECTED_MAX_SEGMENTS: Final = 100_000
EXPECTED_FIRST_RAW_SEGMENTS: Final = 3
EXPECTED_CALLBACKS: Final = 5


@pytest.mark.parametrize(
    ("total_samples", "window_count", "last_core_samples"),
    [
        (SAMPLE_RATE, 1, SAMPLE_RATE),
        (CORE_SAMPLES, 1, CORE_SAMPLES),
        (CORE_SAMPLES + SAMPLE_RATE, 2, SAMPLE_RATE),
        (MAX_DURATION_SAMPLES, 32, CORE_SAMPLES),
    ],
)
def test_planner_covers_actual_samples_once(
    total_samples: int,
    window_count: int,
    last_core_samples: int,
) -> None:
    """One-second, boundary, partial, and eight-hour plans are exact."""
    windows = plan_windows(total_samples)

    assert len(windows) == window_count
    assert windows[0].core_start_sample == 0
    assert windows[-1].core_end_sample == total_samples
    assert windows[-1].core_end_sample - windows[-1].core_start_sample == last_core_samples
    assert all(
        current.core_end_sample == following.core_start_sample
        for current, following in pairwise(windows)
    )
    assert all(
        window.window_end_sample - window.window_start_sample <= MAX_WINDOW_BYTES // 4
        for window in windows
    )


def test_planner_adds_context_without_exceeding_media() -> None:
    """Adjacent full windows overlap by exactly sixty seconds."""
    first, second = plan_windows(2 * CORE_SAMPLES)
    assert first.window_start_sample == 0
    assert first.window_end_sample == CORE_SAMPLES + CONTEXT_SAMPLES
    assert second.window_start_sample == CORE_SAMPLES - CONTEXT_SAMPLES
    assert second.window_end_sample == 2 * CORE_SAMPLES
    assert first.window_end_sample - second.window_start_sample == 2 * CONTEXT_SAMPLES


@pytest.mark.parametrize("total_samples", [0, -1, MAX_DURATION_SAMPLES + 1, True])
def test_planner_rejects_invalid_actual_sample_counts(total_samples: int) -> None:
    """Zero, negative, over-limit, and boolean counts fail closed."""
    with pytest.raises(WorkerError, match="TRANSCRIPTION_FAILED"):
        plan_windows(total_samples)


def test_prompt_tail_normalizes_and_keeps_valid_utf8_suffix() -> None:
    """The next-window prompt never splits a multibyte code point."""
    prompt = PromptTail(max_bytes=MAX_TEST_PROMPT_BYTES)
    prompt.append(" first\n  value ")
    prompt.append("日本語です")

    assert len(prompt.value.encode("utf-8")) <= MAX_TEST_PROMPT_BYTES
    assert "\n" not in prompt.value
    assert prompt.value.endswith("日本語です")
    assert len(PromptTail().value.encode("utf-8")) <= MAX_PROMPT_BYTES


def test_prompt_tail_rejects_invalid_limit_and_ignores_empty_text() -> None:
    """A prompt cannot be unbounded and whitespace cannot grow its state."""
    with pytest.raises(ValueError, match="positive"):
        PromptTail(max_bytes=0)
    prompt = PromptTail(max_bytes=4)
    prompt.append(" \n\t ")
    assert prompt.value == ""


def test_spool_uses_mode_0600_streams_rows_and_deletes_on_exit(tmp_path: Path) -> None:
    """Sensitive rows remain in one exclusive task-local file and are cleaned."""
    with SegmentSpool(tmp_path) as spool:
        first = spool.append(start=1.0, end=2.0, text="first")
        second = spool.append(start=2.0, end=3.0, text="二番目")
        assert first.id == 0
        assert second.id == 1
        assert stat.S_IMODE(spool.path.stat().st_mode) == SECURE_FILE_MODE
        assert tuple(spool.iter_segments()) == (first, second)
        spool_path = spool.path
    assert not spool_path.exists()


def test_spool_rejects_duplicate_file_and_hard_limits(tmp_path: Path) -> None:
    """Exclusive creation and all segment/text/spool ceilings fail closed."""
    existing = tmp_path / "segments.jsonl"
    existing.write_text("foreign", encoding="utf-8")
    with pytest.raises(WorkerError, match="INTERNAL_ERROR"):
        SegmentSpool(tmp_path)
    existing.unlink()

    limits = SpoolLimits(max_segments=1, max_text_bytes=5, max_spool_bytes=100)
    with SegmentSpool(tmp_path, limits=limits) as spool:
        spool.append(start=0.0, end=1.0, text="12345")
        with pytest.raises(WorkerError, match="TRANSCRIPTION_FAILED"):
            spool.append(start=1.0, end=2.0, text="x")

    assert MAX_SEGMENTS == EXPECTED_MAX_SEGMENTS
    assert MAX_SEGMENT_TEXT_BYTES == 16 * 1024
    assert MAX_TOTAL_TEXT_BYTES == 64 * 1024 * 1024
    assert MAX_SPOOL_BYTES == 128 * 1024 * 1024


def test_spool_rejects_untrusted_root_text_and_corrupt_rows(tmp_path: Path) -> None:
    """The spool validates its root, per-row text, and every persisted read."""
    with pytest.raises(WorkerError, match="INTERNAL_ERROR"):
        SegmentSpool(Path("relative-task"))

    with SegmentSpool(tmp_path) as spool:
        with pytest.raises(WorkerError, match="TRANSCRIPTION_FAILED"):
            spool.append(
                start=0.0,
                end=1.0,
                text="x" * (MAX_SEGMENT_TEXT_BYTES + 1),
            )
        spool.append(start=0.0, end=1.0, text="safe")
        assert spool.size_bytes > 0
        spool.path.write_bytes(b"not-json\n")
        with pytest.raises(WorkerError, match="INTERNAL_ERROR"):
            tuple(spool.iter_segments())


def test_segment_ownership_uses_monotonic_watermark_and_stable_prompt(tmp_path: Path) -> None:
    """The earlier window closes drift gaps without prompting duplicated overlap."""
    first, second = plan_windows(2 * CORE_SAMPLES)
    callback_count = 0

    def callback() -> None:
        nonlocal callback_count
        callback_count += 1

    with SegmentSpool(tmp_path) as spool:
        prompt = PromptTail()
        merger = WindowSegmentMerger(spool, prompt)
        first_summary = merger.merge(
            first,
            (
                RawWindowSegment(id=0, start=10.0, end=11.0, text="stable"),
                RawWindowSegment(id=1, start=899.0, end=899.5, text="before"),
                RawWindowSegment(id=2, start=899.5, end=900.5, text="boundary"),
            ),
            on_segment=callback,
        )
        assert first_summary.accepted_segment_count == EXPECTED_FIRST_RAW_SEGMENTS
        assert prompt.value == "stable"

        second_summary = merger.merge(
            second,
            (
                RawWindowSegment(id=0, start=29.5, end=30.5, text="boundary"),
                RawWindowSegment(id=1, start=31.0, end=32.0, text="after"),
            ),
            on_segment=callback,
        )
        rows = tuple(spool.iter_segments())

    assert first_summary.raw_segment_count == EXPECTED_FIRST_RAW_SEGMENTS
    assert second_summary.accepted_segment_count == 1
    assert [row.text for row in rows] == ["stable", "before", "boundary", "after"]
    assert [row.id for row in rows] == [0, 1, 2, 3]
    assert prompt.value == "stable"
    assert callback_count == EXPECTED_CALLBACKS


def test_merger_rejects_out_of_order_range_drift_and_window_replay(tmp_path: Path) -> None:
    """Native iterator drift cannot produce reordered or replayed transcript rows."""
    window = plan_windows(CORE_SAMPLES)[0]
    with SegmentSpool(tmp_path) as spool:
        merger = WindowSegmentMerger(spool, PromptTail())
        with pytest.raises(WorkerError, match="TRANSCRIPTION_FAILED"):
            merger.merge(
                window,
                (
                    RawWindowSegment(id=1, start=2.0, end=3.0, text="later"),
                    RawWindowSegment(id=0, start=1.0, end=2.0, text="earlier"),
                ),
            )

    other = tmp_path / "other"
    other.mkdir()
    with SegmentSpool(other) as spool:
        merger = WindowSegmentMerger(spool, PromptTail())
        with pytest.raises(WorkerError, match="TRANSCRIPTION_FAILED"):
            merger.merge(
                window,
                (RawWindowSegment(id=0, start=901.0, end=901.0, text="outside"),),
            )

    replay_root = tmp_path / "replay"
    replay_root.mkdir()
    with SegmentSpool(replay_root) as spool:
        merger = WindowSegmentMerger(spool, PromptTail())
        merger.merge(window, ())
        with pytest.raises(WorkerError, match="TRANSCRIPTION_FAILED"):
            merger.merge(window, ())


def test_merger_caps_raw_segments_and_accepts_final_endpoint(tmp_path: Path) -> None:
    """A hostile lazy iterator is capped and attempt cleanup owns any partial spool."""
    first = plan_windows(2 * CORE_SAMPLES)[0]
    boundary = RawWindowSegment(id=0, start=900.0, end=900.0, text="boundary")
    with SegmentSpool(tmp_path) as spool:
        merger = WindowSegmentMerger(spool, PromptTail())
        with pytest.raises(WorkerError, match="TRANSCRIPTION_FAILED"):
            merger.merge(first, (boundary for _ in range(10_001)))
        assert spool.segment_count == 1

    final_root = tmp_path / "final"
    final_root.mkdir()
    final = plan_windows(CORE_SAMPLES)[0]
    with SegmentSpool(final_root) as spool:
        WindowSegmentMerger(spool, PromptTail()).merge(final, (boundary,))
        assert [segment.text for segment in spool.iter_segments()] == ["boundary"]


def test_merger_clamps_bounded_final_timestamp_padding(tmp_path: Path) -> None:
    """Known native padding is bounded and cannot escape the actual final window."""
    final = plan_windows(CORE_SAMPLES)[0]
    with SegmentSpool(tmp_path) as spool:
        summary = WindowSegmentMerger(spool, PromptTail()).merge(
            final,
            (
                RawWindowSegment(
                    id=0,
                    start=CORE_SAMPLES / SAMPLE_RATE - 1,
                    end=CORE_SAMPLES / SAMPLE_RATE + MAX_NATIVE_TIMESTAMP_PADDING_SECONDS,
                    text="padded",
                ),
            ),
        )
        rows = tuple(spool.iter_segments())

    assert summary.accepted_segment_count == 1
    assert rows[0].end == CORE_SAMPLES / SAMPLE_RATE


@pytest.mark.parametrize(
    ("start", "end"),
    [
        (CORE_SAMPLES / SAMPLE_RATE + 1, CORE_SAMPLES / SAMPLE_RATE + 1),
        (
            CORE_SAMPLES / SAMPLE_RATE - 1,
            CORE_SAMPLES / SAMPLE_RATE + MAX_NATIVE_TIMESTAMP_PADDING_SECONDS + 0.001,
        ),
    ],
)
def test_merger_rejects_native_timestamps_outside_padding_bound(
    tmp_path: Path,
    start: float,
    end: float,
) -> None:
    """Padding normalization never admits a segment wholly beyond the window or over its cap."""
    final = plan_windows(CORE_SAMPLES)[0]
    with (
        SegmentSpool(tmp_path) as spool,
        pytest.raises(WorkerError, match="TRANSCRIPTION_FAILED"),
    ):
        WindowSegmentMerger(spool, PromptTail()).merge(
            final,
            (RawWindowSegment(id=0, start=start, end=end, text="invalid"),),
        )


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_raw_segment_rejects_non_finite_timestamps(value: float) -> None:
    """NaN and infinity never reach midpoint ownership arithmetic."""
    with pytest.raises(ValidationError):
        RawWindowSegment(id=0, start=value, end=1.0, text="invalid")


def test_raw_segment_rejects_reverse_time_and_oversized_utf8() -> None:
    """Malformed ordering and encoded text limits fail at the native boundary."""
    with pytest.raises(ValidationError):
        RawWindowSegment(id=0, start=2.0, end=1.0, text="invalid")
    with pytest.raises(ValidationError):
        RawWindowSegment(
            id=0,
            start=0.0,
            end=1.0,
            text="あ" * (MAX_SEGMENT_TEXT_BYTES // 3 + 1),
        )
