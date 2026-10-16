import { ProcmonExportService } from "../application/procmon/ProcmonExportService.js";
import { ProcmonExportProvider } from "../procmon/ProcmonExportProvider.js";

/** Compose bundled offline export reading without Process Monitor or any child process. */
export const createProcmonExportService = (): ProcmonExportService =>
  new ProcmonExportService(new ProcmonExportProvider());
