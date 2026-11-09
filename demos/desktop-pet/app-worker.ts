import { hostService } from "@n1h/sweetview/worker";
import { createService } from "./service";

hostService(createService());
