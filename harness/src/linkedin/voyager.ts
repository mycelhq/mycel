// Moved to packages/linkedin (@mycel/linkedin). This shim keeps existing kernel imports working
// and guarantees the package is wired to the kernel host before anything in it runs.
import "./host";
export * from "@mycel/linkedin/voyager";
