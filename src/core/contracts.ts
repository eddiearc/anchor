import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type ContractArtifact = {
  id: string;
  version: number;
  goal: {
    summary: string;
  };
  mode: "standard";
  steps: string[];
  acceptance_criteria: string[];
  files: {
    allowlist: string[];
    denylist: string[];
  };
  commands: string[];
  non_goals: string[];
};

export type ContractFile = {
  path: string;
  content: string;
  sha: string;
  contractId: string;
};

export function createTemplateContract(task: string, runId: string): ContractArtifact {
  return {
    id: contractIdForRun(runId),
    version: 1,
    goal: {
      summary: task
    },
    mode: "standard",
    steps: [
      "Read the approved contract before implementation.",
      "Make only the changes needed to satisfy the goal.",
      "Run the listed verification commands.",
      "Report implementation scope, evidence, verification commands, and risks."
    ],
    acceptance_criteria: [
      "The implementation satisfies the goal summary.",
      "All changed files stay within the contract allowlist and outside the denylist.",
      "Verification commands complete or any failure is explicitly reported with cause.",
      "The final report references this approved contract."
    ],
    files: {
      allowlist: ["src/**", "tests/**", "README.md", "package.json", "tsconfig*.json"],
      denylist: [".env*", "secrets/**", "node_modules/**", "dist/**", ".git/**"]
    },
    commands: ["pnpm typecheck", "pnpm test", "pnpm build"],
    non_goals: [
      "No LLM provider integration.",
      "No real filesystem sandbox enforcement.",
      "No git diff enforcement.",
      "No Web UI."
    ]
  };
}

export async function writeContractArtifact(runsDir: string, runId: string, contract: ContractArtifact): Promise<ContractFile> {
  const artifactPath = contractPathForRun(runsDir, runId);
  const content = serializeContract(contract);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, content);
  return {
    path: artifactPath,
    content,
    sha: sha256(content),
    contractId: contract.id
  };
}

export async function readContractArtifact(runsDir: string, runId: string): Promise<ContractFile | null> {
  const artifactPath = contractPathForRun(runsDir, runId);
  try {
    const content = await readFile(artifactPath, "utf8");
    return {
      path: artifactPath,
      content,
      sha: sha256(content),
      contractId: extractContractId(content) ?? contractIdForRun(runId)
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function contractPathForRun(runsDir: string, runId: string): string {
  return path.join(runsDir, runId, "contract.yaml");
}

export function contractIdForRun(runId: string): string {
  return `contract_${runId}`;
}

export function serializeContract(contract: ContractArtifact): string {
  return [
    `id: ${quote(contract.id)}`,
    `version: ${contract.version}`,
    "goal:",
    `  summary: ${quote(contract.goal.summary)}`,
    `mode: ${quote(contract.mode)}`,
    "steps:",
    ...contract.steps.map((step) => `  - ${quote(step)}`),
    "acceptance_criteria:",
    ...contract.acceptance_criteria.map((criterion) => `  - ${quote(criterion)}`),
    "files:",
    "  allowlist:",
    ...contract.files.allowlist.map((item) => `    - ${quote(item)}`),
    "  denylist:",
    ...contract.files.denylist.map((item) => `    - ${quote(item)}`),
    "commands:",
    ...contract.commands.map((command) => `  - ${quote(command)}`),
    "non_goals:",
    ...contract.non_goals.map((nonGoal) => `  - ${quote(nonGoal)}`),
    ""
  ].join("\n");
}

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function extractContractId(content: string): string | null {
  const match = /^id:\s*(?:"([^"]+)"|'([^']+)'|([^\n#]+))/m.exec(content);
  return match ? (match[1] ?? match[2] ?? match[3]).trim() : null;
}

function quote(value: string): string {
  return JSON.stringify(value);
}
