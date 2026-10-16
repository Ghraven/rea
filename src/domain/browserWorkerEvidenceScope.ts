import { z } from "zod";

import {
  browserAllowedOriginsSchema,
  browserWorkerTargetIdsSchema,
  sanitizeBrowserUrl,
} from "./browserObservation.js";
import { webPageInspectionSchema } from "./browserObservationSchemas.js";

/** Shared selection and origin consistency boundary for retained worker Evidence. */
export const browserWorkerEvidenceScopeSchema = z
  .object({
    parameters: z.object({
      target_id: z.string().trim().min(1),
      include_script_sources: z.boolean(),
      allowed_origins: browserAllowedOriginsSchema,
      worker_target_ids: browserWorkerTargetIdsSchema,
    }),
    normalized_result: webPageInspectionSchema.pick({ workers: true }),
  })
  .superRefine(({ parameters, normalized_result }, context) => {
    const allowed = new Set(parameters.allowed_origins);
    for (const [index, worker] of normalized_result.workers.entries()) {
      const path = ["normalized_result", "workers", index];
      const origin = sanitizeBrowserUrl(worker.url).origin;
      if (origin === null || origin !== worker.origin || !allowed.has(origin))
        context.addIssue({
          code: "custom",
          path,
          message:
            "Worker Evidence target is outside its recorded origin scope",
        });
      const observation = worker.observation;
      if (observation === undefined) continue;
      if (
        !parameters.include_script_sources &&
        observation.scripts.some(({ source }) => source.included)
      )
        context.addIssue({
          code: "custom",
          path: [...path, "observation", "scripts"],
          message:
            "Worker Evidence contains source without source-capture selection",
        });
      if (
        observation.page_target_id !==
        (observation.ownership === "unknown" ? null : parameters.target_id)
      )
        context.addIssue({
          code: "custom",
          path: [...path, "observation", "page_target_id"],
          message:
            "Worker Evidence ownership disagrees with its recorded page target",
        });
      const selected =
        parameters.worker_target_ids?.includes(worker.target_id) ?? false;
      if (
        observation.selected_explicitly !== selected ||
        (observation.ownership === "unknown" &&
          !selected &&
          observation.scripts.some(({ source }) => source.included))
      )
        context.addIssue({
          code: "custom",
          path: [...path, "observation"],
          message:
            "Worker Evidence disagrees with its recorded target selection",
        });
      for (const [scriptIndex, script] of observation.scripts.entries()) {
        const scriptOrigin = sanitizeBrowserUrl(script.url).origin;
        if (scriptOrigin === null || !allowed.has(scriptOrigin))
          context.addIssue({
            code: "custom",
            path: [...path, "observation", "scripts", scriptIndex],
            message:
              "Worker Evidence script is outside its recorded origin scope",
          });
      }
    }
  });
