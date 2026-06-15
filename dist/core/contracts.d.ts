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
export type ContractCriterion = {
    id: string;
    passes: boolean;
};
export type ContractFile = {
    path: string;
    content: string;
    sha: string;
    contractId: string;
};
export declare function createTemplateContract(task: string, taskId: string): ContractArtifact;
export declare function writeContractArtifact(artifactsDir: string, taskId: string, contract: ContractArtifact): Promise<ContractFile>;
export declare function writeRawContract(artifactsDir: string, taskId: string, rawYaml: string): Promise<ContractFile>;
export declare function readContractArtifact(artifactsDir: string, taskId: string): Promise<ContractFile | null>;
export declare function contractPathForTask(artifactsDir: string, taskId: string): string;
export declare function contractIdForTask(taskId: string): string;
export declare function serializeContract(contract: ContractArtifact): string;
export declare function readDefaultFailCriteria(contract: string): ContractCriterion[];
export declare function requiresDefaultFailCriteria(contract: string): boolean;
export declare function readContractMode(contract: string): "quick" | "standard" | "thorough" | null;
export declare function readContractStepIds(contract: string): string[];
export declare function sha256(content: string): string;
