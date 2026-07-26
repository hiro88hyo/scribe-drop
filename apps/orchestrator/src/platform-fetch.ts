export function resolvePlatformFetch(injectedFetch: typeof fetch | undefined): typeof fetch {
  if (injectedFetch !== undefined) {
    return injectedFetch;
  }

  return (input, init) => globalThis.fetch(input, init);
}
