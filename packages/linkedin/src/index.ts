// @mycel/linkedin — the self-hosted LinkedIn (Voyager) core.
//
// The seams a host must implement live in ./host. Everything else is importable by subpath
// (`@mycel/linkedin/voyager`, `/search`, `/connect`, …) exactly as it was inside the kernel.
export * from "./host";
export * from "./browser-transport";
