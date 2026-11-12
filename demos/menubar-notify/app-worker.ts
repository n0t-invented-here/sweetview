// Worker entry: owns the Bun event loop and the service.
import { hostService } from "@n1h/sweetview/worker";
import { createService } from "./service";

hostService(createService());
