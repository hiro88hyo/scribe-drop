interface ServiceWorkerContainerPort {
  register(scriptURL: string, options: RegistrationOptions): Promise<unknown>;
}

export async function registerServiceWorker(
  serviceWorker: ServiceWorkerContainerPort | undefined,
): Promise<boolean> {
  if (serviceWorker === undefined) {
    return false;
  }
  try {
    await serviceWorker.register("/service-worker.js", {
      scope: "/",
      updateViaCache: "none",
    });
    return true;
  } catch {
    return false;
  }
}
