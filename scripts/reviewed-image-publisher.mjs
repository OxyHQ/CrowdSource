import { createHash } from "node:crypto";

// Reviewed ECR-only publication is not an ECS deployment. Keep this exception
// closed to all three reviewed inputs; changing any requires an explicit review
// and refreshed pins, not a filename-only exemption from deployment guards.
const reviewed = {
  ".github/workflows/publish-reviewed-images.yml": "aa25f35b348aa2476c0b1f2ad3a8dbb4f1fed13ee05ecd95c8b2952b780263c3",
  ".github/scripts/publish-reviewed-image.py": "4c20fa31ef8bcd5f18e8e894d6fd35157e7bcce1ef9392f70c21cdd6aa86f17e",
  ".github/scripts/reviewed-images.json": "6d47a74e2beae224819a01478ba2489cce481aca9d12e6370eb382ad62fba4a1"
};

export function isReviewedImagePublisher(name, workflow, read) {
  if (name !== "publish-reviewed-images.yml") return false;
  try {
    for (const [file, expected] of Object.entries(reviewed)) {
      if (createHash("sha256").update(read(file)).digest("hex") !== expected) return false;
    }
    if (Object.keys(workflow.on ?? {}).join() !== "workflow_dispatch" ||
        workflow.on.workflow_dispatch.inputs?.expected_source_sha?.required !== true) return false;
    return Object.values(workflow.jobs ?? {}).every((job) => {
      const guard = "python3 -B .github/scripts/publish-reviewed-image.py ";
      const runs = (job.steps ?? []).filter((step) => step.run).map((step) => step.run);
      return job["runs-on"] === "ubuntu-24.04-arm" &&
        job.if.includes("github.event_name == 'workflow_dispatch'") &&
        job.if.includes("github.ref == 'refs/heads/main'") &&
        job.env?.EXPECTED_SOURCE_SHA === "${{ inputs.expected_source_sha }}" &&
        runs.length === 3 &&
        ["guard", "vacancy", "verify"].every((phase, i) =>
          runs[i].startsWith(guard + phase + " --recipe "));
    });
  } catch {
    return false;
  }
}
