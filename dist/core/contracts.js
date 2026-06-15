import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
export function createTemplateContract(task, taskId) {
    return {
        id: contractIdForTask(taskId),
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
            allowlist: ["anchor-output/**", "src/**", "tests/**", "README.md", "package.json", "tsconfig*.json"],
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
export async function writeContractArtifact(artifactsDir, taskId, contract) {
    const artifactPath = contractPathForTask(artifactsDir, taskId);
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
export async function writeRawContract(artifactsDir, taskId, rawYaml) {
    const artifactPath = contractPathForTask(artifactsDir, taskId);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, rawYaml);
    return {
        path: artifactPath,
        content: rawYaml,
        sha: sha256(rawYaml),
        contractId: contractIdForTask(taskId)
    };
}
export async function readContractArtifact(artifactsDir, taskId) {
    const artifactPath = contractPathForTask(artifactsDir, taskId);
    try {
        const content = await readFile(artifactPath, "utf8");
        return {
            path: artifactPath,
            content,
            sha: sha256(content),
            contractId: extractContractId(content) ?? contractIdForTask(taskId)
        };
    }
    catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}
export function contractPathForTask(artifactsDir, taskId) {
    return path.join(artifactsDir, taskId, "contract.yaml");
}
export function contractIdForTask(taskId) {
    return `contract_${taskId}`;
}
export function serializeContract(contract) {
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
export function readDefaultFailCriteria(contract) {
    const lines = contract.split("\n");
    const criteria = [];
    let inCriteria = false;
    let criteriaIndent = 0;
    let current = null;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        if (trimmed === "criteria:") {
            inCriteria = true;
            criteriaIndent = indentOf(line);
            current = null;
            continue;
        }
        if (inCriteria && indentOf(line) <= criteriaIndent) {
            inCriteria = false;
            current = null;
        }
        if (!inCriteria)
            continue;
        const idMatch = trimmed.match(/^-\s*id:\s*(.+)$/);
        if (idMatch) {
            current = { id: unquote(idMatch[1]), passes: true };
            criteria.push(current);
            continue;
        }
        const passesMatch = trimmed.match(/^passes:\s*(true|false)\s*$/);
        if (passesMatch && current) {
            current.passes = passesMatch[1] === "true";
        }
    }
    return criteria.filter((criterion) => criterion.passes === false);
}
export function requiresDefaultFailCriteria(contract) {
    const mode = readContractMode(contract);
    return mode !== "quick";
}
export function readContractMode(contract) {
    const match = /^mode:\s*(?:"([^"]+)"|'([^']+)'|([^\n#]+))/m.exec(contract);
    const mode = match ? (match[1] ?? match[2] ?? match[3]).trim() : null;
    return mode === "quick" || mode === "standard" || mode === "thorough" ? mode : null;
}
export function readContractStepIds(contract) {
    const lines = contract.split("\n");
    const stepIds = [];
    let inSteps = false;
    let stepsIndent = 0;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        if (trimmed === "steps:") {
            inSteps = true;
            stepsIndent = indentOf(line);
            continue;
        }
        if (inSteps && indentOf(line) <= stepsIndent) {
            inSteps = false;
        }
        if (!inSteps)
            continue;
        const idMatch = trimmed.match(/^-\s*id:\s*(.+)$/);
        if (idMatch && indentOf(line) === stepsIndent + 2) {
            stepIds.push(unquote(idMatch[1]));
        }
    }
    return Array.from(new Set(stepIds.filter(Boolean)));
}
export function sha256(content) {
    return createHash("sha256").update(content).digest("hex");
}
function extractContractId(content) {
    const match = /^id:\s*(?:"([^"]+)"|'([^']+)'|([^\n#]+))/m.exec(content);
    return match ? (match[1] ?? match[2] ?? match[3]).trim() : null;
}
function quote(value) {
    return JSON.stringify(value);
}
function indentOf(line) {
    return line.match(/^\s*/)?.[0].length ?? 0;
}
function unquote(value) {
    const trimmed = value.trim();
    try {
        return JSON.parse(trimmed);
    }
    catch {
        return trimmed.replace(/^['"]|['"]$/g, "");
    }
}
