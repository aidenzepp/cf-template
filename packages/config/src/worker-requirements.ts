import type { Providers, WorkerServices } from "@alchemy.run/cloudflare";
import type { PlatformServices } from "alchemy/Platform";

/**
 * The services a Worker program may leave to its host: Alchemy's Worker services, the Cloudflare
 * providers, and the platform services. A Worker program ends with
 * `Effect.satisfiesServicesType<WorkerRequirements>()` so a user service with no provider fails to
 * compile instead of reaching deploy time.
 */
export type WorkerRequirements = WorkerServices | Providers | PlatformServices;
