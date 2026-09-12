// Moved to packages/linkedin (@mycel/linkedin). This shim keeps existing kernel imports working
// and guarantees the package is wired to the kernel host before anything in it runs.
import "./host";
export * from "@mycel/linkedin/engage";
// Re-read here (a local export shadows the star re-export) so a cache-busted re-import of THIS
// module observes the current environment — the executors in the package check it at call time.
export const WARMUP_ENABLED = process.env.MYCEL_LINKEDIN_WARMUP === "1";
