import type { DeviceDriver } from "./drivers/driver";

// Startup reconciliation: destroy instances that carry our tag but are not
// backed by a live session (orphans from a crashed run). Runs before the server
// accepts traffic, so "not backed by a session" == "tagged and present".
// Untagged devices (the user's own AVDs/sims) are never touched.
export async function reconcile(driver: DeviceDriver): Promise<string[]> {
  const discovered = await driver.discoverInstances();
  const destroyed: string[] = [];
  for (const instance of discovered) {
    if (instance.tagged) {
      await driver.destroyByRef(instance.ref);
      destroyed.push(instance.ref);
    }
  }
  return destroyed;
}
