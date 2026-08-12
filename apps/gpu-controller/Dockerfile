# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# gcr.io/distroless/nodejs24-debian13:nonroot at Node.js 24.18.0,
# linux/amd64 manifest
FROM --platform=linux/amd64 gcr.io/distroless/nodejs24-debian13@sha256:b1386d556b478c420927eb212236bfb31be9834a4549850a060a6351f7fff514

WORKDIR /app

COPY --chown=10001:10001 . .

ENV HOME=/nonexistent \
    NODE_ENV=production \
    PORT=8080

LABEL org.opencontainers.image.title="ScribeDrop GPU Controller" \
    org.opencontainers.image.base.name="gcr.io/distroless/nodejs24-debian13:nonroot" \
    org.opencontainers.image.base.digest="sha256:b1386d556b478c420927eb212236bfb31be9834a4549850a060a6351f7fff514" \
    io.scribedrop.node.version="24.18.0" \
    io.scribedrop.controller.policy="cloud_run_jobs_l4_v1"

EXPOSE 8080

USER 10001:10001

ENTRYPOINT ["/nodejs/bin/node", "dist/entrypoint.js"]
CMD []
