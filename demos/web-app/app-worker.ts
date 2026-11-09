// Worker entry for the app. Owns the Bun event loop and the service.
import { createService } from "web-app-backend";
import { hostService } from "@n1h/sweetview/worker";

hostService(createService());
