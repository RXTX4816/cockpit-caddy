import { runBuild } from "@rxtx4816/cockpit-plugin-base-react/esbuild.config.base";
import * as esbuild from "esbuild";

await runBuild({ esbuild, product: "cockpit-caddy" });
