import * as fs from 'fs';
import * as path from 'path';
import { Task, WriteTask, EditTask, CommandTask, VerifyTask, TaskQueue } from './taskSplitter';
import { applyEdits } from './editApplier';
import { guardTool, GuardDecision } from '../guards/toolGuards';
import { validateFile, ValidationResult } from '../validators/postWriteValidators';
import { writeTextPreservingEolSync, readTextNormalizedSync, detectSiblingEol } from '../platform/eol';
import { runCommandSequence } from '../platform/commandSequence';
import { ModelProfile } from '../config/modelProfile';

export interface CommandExecutionOutcome {
    cmd: string;
    exitCode: number;
    output: string;
    ok: boolean;
}

export interface TaskOutcome {
    task: Task;
    ok: boolean;
    guard?: GuardDecision;
    validation?: ValidationResult[];
    commandResults?: CommandExecutionOutcome[];
    error?: string;
}

export interface TaskExecutorDeps {
    workspaceRoot: string;
    profile: ModelProfile;
    recordBackup?: (filepath: string, oldContent: string | null) => void;
    postStatus?: (msg: string) => void;
}

export class TaskExecutor {
    private deps: TaskExecutorDeps;

    constructor(deps: TaskExecutorDeps) {
        this.deps = deps;
    }

    /**
     * Executes a single task with guards, backup checkpoints, and post-write syntax validation.
     */
    public async run(task: Task): Promise<TaskOutcome> {
        if (task.kind === 'write') {
            return await this.executeWrite(task);
        } else if (task.kind === 'edit') {
            return await this.executeEdit(task);
        } else if (task.kind === 'command' || task.kind === 'verify') {
            return await this.executeCommands(task);
        }

        return {
            task,
            ok: false,
            error: `Unsupported task kind: ${(task as any).kind}`
        };
    }

    /**
     * Executes all tasks in a TaskQueue sequentially, stopping at the first failure.
     */
    public async executeQueue(
        queue: TaskQueue,
        onProgress?: (outcome: TaskOutcome) => void
    ): Promise<{ outcomes: TaskOutcome[]; remainingQueue: Task[]; ok: boolean }> {
        const outcomes: TaskOutcome[] = [];

        while (queue.size() > 0) {
            const currentTask = queue.next();
            if (!currentTask) break;

            this.deps.postStatus?.(`Executing: [${currentTask.kind.toUpperCase()}] ${this.getTaskTitle(currentTask)}`);
            const outcome = await this.run(currentTask);
            outcomes.push(outcome);
            onProgress?.(outcome);

            if (!outcome.ok) {
                return {
                    outcomes,
                    remainingQueue: queue.remaining(),
                    ok: false
                };
            }
        }

        return {
            outcomes,
            remainingQueue: [],
            ok: true
        };
    }

    private async executeWrite(task: WriteTask): Promise<TaskOutcome> {
        const { workspaceRoot } = this.deps;
        const fullPath = path.resolve(workspaceRoot, task.path);

        // 1. Tool guard
        const guard = guardTool(
            { name: 'write_file', args: { filepath: task.path, content: task.content } },
            { workspaceRoot, destination: 'web', blockServers: true }
        );

        if (!guard.allow) {
            return {
                task,
                ok: false,
                guard,
                error: `Guard rejected write for '${task.path}': ${guard.reason}`
            };
        }

        // 2. Backup checkpoint
        const fileExists = fs.existsSync(fullPath);
        const oldContent = fileExists ? fs.readFileSync(fullPath, 'utf8') : null;
        if (this.deps.recordBackup) {
            this.deps.recordBackup(fullPath, oldContent);
        }

        // 3. Write preserving EOL
        const targetEol = fileExists ? detectSiblingEol(fullPath) : '\n';
        writeTextPreservingEolSync(fullPath, task.content, targetEol);

        // 4. Post-write syntax validation
        const validation = await validateFile(fullPath, { workspaceRoot });
        const hasSyntaxError = validation.some(v => !v.ok && !v.skipped);

        return {
            task,
            ok: !hasSyntaxError,
            guard,
            validation,
            error: hasSyntaxError ? `Syntax error detected in '${task.path}'` : undefined
        };
    }

    private async executeEdit(task: EditTask): Promise<TaskOutcome> {
        const { workspaceRoot } = this.deps;
        const fullPath = path.resolve(workspaceRoot, task.path);

        if (!fs.existsSync(fullPath)) {
            return {
                task,
                ok: false,
                error: `Cannot edit file '${task.path}': file does not exist on disk.`
            };
        }

        const normRead = readTextNormalizedSync(fullPath);
        const editRes = applyEdits(normRead.text, task.blocks);

        if (!editRes.ok || !editRes.newContent) {
            const fail = editRes.failures[0];
            return {
                task,
                ok: false,
                error: `Failed to apply edit to '${task.path}': SEARCH block not found (${fail?.reason || 'MISMATCH'})`
            };
        }

        // Guard check
        const guard = guardTool(
            { name: 'edit_file', args: { filepath: task.path, content: editRes.newContent } },
            { workspaceRoot, destination: 'web', blockServers: true }
        );

        if (!guard.allow) {
            return {
                task,
                ok: false,
                guard,
                error: `Guard rejected edit for '${task.path}': ${guard.reason}`
            };
        }

        // Backup
        if (this.deps.recordBackup) {
            this.deps.recordBackup(fullPath, normRead.text);
        }

        // Write
        writeTextPreservingEolSync(fullPath, editRes.newContent, normRead.eol, normRead.hadBom);

        // Post-write validation
        const validation = await validateFile(fullPath, { workspaceRoot });
        const hasSyntaxError = validation.some(v => !v.ok && !v.skipped);

        return {
            task,
            ok: !hasSyntaxError,
            guard,
            validation,
            error: hasSyntaxError ? `Syntax error in edited file '${task.path}'` : undefined
        };
    }

    private async executeCommands(task: CommandTask | VerifyTask): Promise<TaskOutcome> {
        const { workspaceRoot } = this.deps;
        const commandResults: CommandExecutionOutcome[] = [];

        for (const cmd of task.commands) {
            // Guard check
            const guard = guardTool(
                { name: 'run_in_terminal', args: { command: cmd } },
                { workspaceRoot, destination: 'web', blockServers: true }
            );

            if (!guard.allow) {
                return {
                    task,
                    ok: false,
                    guard,
                    commandResults,
                    error: `Command '${cmd}' blocked by safety guard: ${guard.reason}`
                };
            }

            const seq = await runCommandSequence(cmd, workspaceRoot, {
                workspaceRoot,
                timeoutMs: 60000
            });

            const failing = seq.results.find(r => !r.ok);
            const exitCode = failing ? (failing.exitCode ?? 1) : 0;
            const ok = seq.ok;

            commandResults.push({
                cmd,
                exitCode,
                output: seq.combinedOutput,
                ok
            });

            if (!ok) {
                return {
                    task,
                    ok: false,
                    commandResults,
                    error: `Command failed with exit code ${exitCode}: ${cmd}`
                };
            }
        }

        return {
            task,
            ok: true,
            commandResults
        };
    }

    private getTaskTitle(task: Task): string {
        if (task.kind === 'write' || task.kind === 'edit') return task.path;
        if (task.kind === 'command' || task.kind === 'verify') return task.commands.join('; ');
        return '';
    }
}
