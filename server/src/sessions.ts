import type { Clock } from "./clock";
import type { ServerConfig } from "./config";
import { AppError } from "./errors";
import type {
  DeviceDriver,
  DeviceHandle,
  DeviceVerb,
  Platform,
  ResetMode,
  TemplateConfig,
} from "./drivers/driver";
import { AsyncQueue } from "./util/async-queue";

export interface AdbAccess {
  host: string;
  port: number;
  serial: string;
}

export type WaitEvent =
  | { status: "queued"; position: number }
  | { status: "active"; sessionId: string; templateVersion: number }
  | { status: "gone" };

interface Session {
  id: string;
  platform: Platform;
  template: TemplateConfig;
  status: "queued" | "active";
  handle: DeviceHandle | null;
  createdAt: number;
  leasedAt: number | null;
  expiresAt: number;
  ttlMs: number;
  listeners: Set<(event: WaitEvent) => void>;
  adb: AdbAccess | null;
}

export interface SessionView {
  sessionId: string;
  status: "queued" | "active";
  template: string;
  templateVersion: number;
  leasedAt?: string;
  expiresAt?: string;
  position?: number;
  adb?: AdbAccess;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly queues: Record<Platform, string[]> = {
    android: [],
    ios: [],
  };
  private counter = 0;

  constructor(
    private readonly driver: DeviceDriver,
    private readonly config: ServerConfig,
    private readonly clock: Clock,
  ) {
    this.clock.onTick(() => {
      void this.sweep();
    });
  }

  // --- public API ---------------------------------------------------------

  async create(templateSlug: string, ttlMs?: number): Promise<SessionView> {
    const template = this.config.templates.find((t) => t.slug === templateSlug);
    if (!template) {
      throw new AppError(
        "template_not_found",
        `Unknown template: ${templateSlug}`,
      );
    }

    this.counter += 1;
    const now = this.clock.now();
    const session: Session = {
      id: `s_${this.counter}`,
      platform: template.platform,
      template,
      status: "queued",
      handle: null,
      createdAt: now,
      leasedAt: null,
      expiresAt: now + (ttlMs ?? this.config.ttlMs),
      ttlMs: ttlMs ?? this.config.ttlMs,
      listeners: new Set(),
      adb: null,
    };
    this.sessions.set(session.id, session);

    if (this.activeCount(template.platform) < this.config.maxByPlatform[template.platform]) {
      await this.activate(session);
    } else {
      this.queues[template.platform].push(session.id);
    }

    return this.view(session);
  }

  // Lease, optionally blocking until the device is active. This is the default
  // client path: one call gets you a usable device.
  async createAndWait(
    templateSlug: string,
    ttlMs: number | undefined,
    opts: { wait: boolean; failIfBusy: boolean },
  ): Promise<SessionView> {
    const view = await this.create(templateSlug, ttlMs);
    if (view.status === "active") return view;
    // Queued:
    if (opts.failIfBusy) {
      await this.release(view.sessionId);
      throw new AppError("pool_full", "No capacity available for that platform");
    }
    if (!opts.wait) return view;
    await this.waitForActive(view.sessionId);
    return this.get(view.sessionId);
  }

  // Resolve once the session is active (device booted, tunnel up), or reject if
  // it's removed first.
  waitForActive(id: string): Promise<void> {
    const session = this.requireSession(id);
    if (session.status === "active" && session.handle) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const listener = (event: WaitEvent) => {
        if (event.status === "active") {
          session.listeners.delete(listener);
          resolve();
        } else if (event.status === "gone") {
          session.listeners.delete(listener);
          reject(new AppError("session_not_found", `Session ${id} was removed before activating`));
        }
      };
      session.listeners.add(listener);
    });
  }

  getAdb(id: string): AdbAccess {
    const session = this.requireActive(id);
    if (!session.adb) {
      throw new AppError("adb_unavailable", `Session ${id} has no adb interface`);
    }
    return session.adb;
  }

  get(id: string): SessionView {
    const session = this.requireSession(id);
    return this.view(session);
  }

  list(): SessionView[] {
    return [...this.sessions.values()].map((s) => this.view(s));
  }

  capacity(): Record<Platform, { max: number; active: number; queued: number }> {
    const build = (platform: Platform) => ({
      max: this.config.maxByPlatform[platform],
      active: this.activeCount(platform),
      queued: this.queues[platform].length,
    });
    return { android: build("android"), ios: build("ios") };
  }

  async release(id: string): Promise<{ sessionId: string; released: true }> {
    const session = this.sessions.get(id);
    if (!session) {
      // Idempotent: releasing an unknown/already-gone session still succeeds.
      return { sessionId: id, released: true };
    }
    await this.remove(session, "gone");
    return { sessionId: id, released: true };
  }

  async reset(
    id: string,
    mode: ResetMode,
  ): Promise<{ sessionId: string; status: "active"; mode: ResetMode }> {
    const session = this.requireActive(id);
    if (!session.handle) {
      throw new AppError("session_not_active", `Session ${id} is still booting`);
    }
    await this.driver.reset(session.handle, mode);
    this.touch(session);
    return { sessionId: id, status: "active", mode };
  }

  heartbeat(id: string): { sessionId: string; expiresAt: string } {
    const session = this.requireSession(id);
    this.touch(session);
    return { sessionId: id, expiresAt: this.clock.toIso(session.expiresAt) };
  }

  // Resolve an active session for a device operation, enforcing platform
  // capability. Any device op also counts as a heartbeat.
  resolveForVerb(id: string, verb: DeviceVerb): { handle: DeviceHandle; platform: Platform } {
    const session = this.requireActive(id);
    if (!session.handle) {
      // Slot reserved but the device is still booting.
      throw new AppError("session_not_active", `Session ${id} is still booting`);
    }
    if (!this.driver.supports(session.platform, verb)) {
      throw new AppError(
        "unsupported_on_platform",
        `Verb '${verb}' is not supported on ${session.platform}`,
      );
    }
    this.touch(session);
    return { handle: session.handle as DeviceHandle, platform: session.platform };
  }

  // SSE: stream wait events until the session is active or gone.
  async *watch(id: string, signal: AbortSignal): AsyncIterable<WaitEvent> {
    const session = this.requireSession(id);
    const queue = new AsyncQueue<WaitEvent>();
    const listener = (event: WaitEvent) => queue.push(event);
    session.listeners.add(listener);

    // Seed with current state.
    if (session.status === "active") {
      queue.push({
        status: "active",
        sessionId: session.id,
        templateVersion: session.template.version,
      });
    } else {
      queue.push({ status: "queued", position: this.positionOf(session) });
    }

    const onAbort = () => queue.close();
    signal.addEventListener("abort", onAbort);

    try {
      for await (const event of queue) {
        yield event;
        if (event.status === "active" || event.status === "gone") {
          return;
        }
      }
    } finally {
      session.listeners.delete(listener);
      signal.removeEventListener("abort", onAbort);
    }
  }

  // Reap expired sessions. Public so the reaper tick and tests can call it.
  async sweep(): Promise<void> {
    const now = this.clock.now();
    const expired = [...this.sessions.values()].filter((s) => now > s.expiresAt);
    for (const session of expired) {
      await this.remove(session, "gone");
    }
  }

  driverInstanceCount(): number {
    return this.driver.instanceCount();
  }

  // --- internals ----------------------------------------------------------

  private activeCount(platform: Platform): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.platform === platform && session.status === "active") count += 1;
    }
    return count;
  }

  private async activate(session: Session): Promise<void> {
    // Reserve the slot SYNCHRONOUSLY (before the async boot) by marking the
    // session active up front. activeCount() counts status === "active", so
    // concurrent create()/fillSlots() calls see this reservation immediately and
    // the per-platform cap is never exceeded — even when driver.lease() blocks
    // for a real device boot. The handle is null until the boot completes.
    session.status = "active";
    session.leasedAt = this.clock.now();
    try {
      session.handle = await this.driver.lease(session.template);
    } catch (err) {
      // Boot failed — release the reservation so the slot frees up.
      this.sessions.delete(session.id);
      this.notify(session, { status: "gone" });
      await this.fillSlots(session.platform);
      throw err;
    }
    // Record how to reach this device over adb (shared adb server + serial), if
    // it has an adb interface.
    session.adb = this.driver.adbAccess(session.handle);
    session.expiresAt = this.clock.now() + session.ttlMs;
    this.notify(session, {
      status: "active",
      sessionId: session.id,
      templateVersion: session.template.version,
    });
  }

  private async remove(session: Session, reason: "gone"): Promise<void> {
    const platform = session.platform;
    session.adb = null;
    if (session.status === "active" && session.handle) {
      await this.driver.destroy(session.handle);
    } else {
      const queue = this.queues[platform];
      const index = queue.indexOf(session.id);
      if (index >= 0) queue.splice(index, 1);
    }
    this.sessions.delete(session.id);
    this.notify(session, { status: reason });
    await this.fillSlots(platform);
    this.broadcastPositions(platform);
  }

  // Promote queued sessions into freed slots, FIFO.
  private async fillSlots(platform: Platform): Promise<void> {
    const queue = this.queues[platform];
    while (
      queue.length > 0 &&
      this.activeCount(platform) < this.config.maxByPlatform[platform]
    ) {
      const nextId = queue.shift() as string;
      const next = this.sessions.get(nextId);
      if (!next) continue;
      await this.activate(next);
    }
  }

  private broadcastPositions(platform: Platform): void {
    const queue = this.queues[platform];
    queue.forEach((id, index) => {
      const session = this.sessions.get(id);
      if (session) {
        this.notify(session, { status: "queued", position: index + 1 });
      }
    });
  }

  private positionOf(session: Session): number {
    const queue = this.queues[session.platform];
    const index = queue.indexOf(session.id);
    return index < 0 ? 0 : index + 1;
  }

  private touch(session: Session): void {
    session.expiresAt = this.clock.now() + session.ttlMs;
  }

  private notify(session: Session, event: WaitEvent): void {
    for (const listener of session.listeners) {
      listener(event);
    }
  }

  private requireSession(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) {
      throw new AppError("session_not_found", `Unknown session: ${id}`);
    }
    return session;
  }

  private requireActive(id: string): Session {
    const session = this.requireSession(id);
    if (session.status !== "active") {
      throw new AppError("session_not_active", `Session ${id} is not active`);
    }
    return session;
  }

  private view(session: Session): SessionView {
    const base: SessionView = {
      sessionId: session.id,
      status: session.status,
      template: session.template.slug,
      templateVersion: session.template.version,
    };
    if (session.status === "active") {
      base.leasedAt = session.leasedAt ? this.clock.toIso(session.leasedAt) : undefined;
      base.expiresAt = this.clock.toIso(session.expiresAt);
      if (session.adb) base.adb = session.adb;
    } else {
      base.position = this.positionOf(session);
    }
    return base;
  }
}
