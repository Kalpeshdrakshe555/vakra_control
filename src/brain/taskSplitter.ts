import { ParsedReply } from './protocolParser';
import { ModelProfile } from '../config/modelProfile';
import { SearchReplaceBlock } from './editApplier';

export type TaskKind = 'write' | 'edit' | 'command' | 'verify';

export interface BaseTask {
    id: string;
    kind: TaskKind;
    dependsOnPrevious?: boolean;
}

export interface WriteTask extends BaseTask {
    kind: 'write';
    path: string;
    content: string;
    part?: { index: number; total: number };
}

export interface EditTask extends BaseTask {
    kind: 'edit';
    path: string;
    blocks: SearchReplaceBlock[];
}

export interface CommandTask extends BaseTask {
    kind: 'command';
    commands: string[];
}

export interface VerifyTask extends BaseTask {
    kind: 'verify';
    commands: string[];
}

export type Task = WriteTask | EditTask | CommandTask | VerifyTask;

export class TaskQueue {
    private tasks: Task[];

    constructor(tasks: Task[]) {
        this.tasks = [...tasks];
    }

    public next(): Task | undefined {
        return this.tasks.shift();
    }

    public peek(): Task | undefined {
        return this.tasks[0];
    }

    public remaining(): Task[] {
        return [...this.tasks];
    }

    public size(): number {
        return this.tasks.length;
    }
}

/**
 * Splits a ParsedReply into a deterministic, safe queue of atomic tasks.
 */
export function splitReplyIntoTasks(reply: ParsedReply, profile: ModelProfile): TaskQueue {
    const tasks: Task[] = [];
    let taskCounter = 1;

    // 1. Files to Write
    // Order according to manifest if manifest is provided, otherwise reply order
    const orderedFiles = [...reply.files];
    if (reply.manifest.length > 0) {
        orderedFiles.sort((a, b) => {
            const idxA = reply.manifest.indexOf(a.path);
            const idxB = reply.manifest.indexOf(b.path);
            if (idxA !== -1 && idxB !== -1) return idxA - idxB;
            if (idxA !== -1) return -1;
            if (idxB !== -1) return 1;
            return 0;
        });
    }

    for (const file of orderedFiles) {
        tasks.push({
            id: `task_${taskCounter++}_write_${file.path.replace(/[^a-zA-Z0-9]/g, '_')}`,
            kind: 'write',
            path: file.path,
            content: file.content
        });
    }

    // 2. Edits
    for (const edit of reply.edits) {
        // Chunk edits if exceeding maxEditsPerFile
        const chunkSize = profile.maxEditsPerFile;
        for (let i = 0; i < edit.blocks.length; i += chunkSize) {
            const chunk = edit.blocks.slice(i, i + chunkSize);
            tasks.push({
                id: `task_${taskCounter++}_edit_${edit.path.replace(/[^a-zA-Z0-9]/g, '_')}`,
                kind: 'edit',
                path: edit.path,
                blocks: chunk
            });
        }
    }

    // 3. Commands (chunked by maxCommandsPerStep)
    if (reply.commands.length > 0) {
        // Deduplicate consecutive identical commands
        const dedupedCommands: string[] = [];
        let lastCmd: string | null = null;
        for (const cmd of reply.commands) {
            if (cmd !== lastCmd) {
                dedupedCommands.push(cmd);
                lastCmd = cmd;
            }
        }

        const cmdChunkSize = profile.maxCommandsPerStep;
        for (let i = 0; i < dedupedCommands.length; i += cmdChunkSize) {
            const chunk = dedupedCommands.slice(i, i + cmdChunkSize);
            tasks.push({
                id: `task_${taskCounter++}_cmd_${i + 1}`,
                kind: 'command',
                commands: chunk,
                dependsOnPrevious: tasks.length > 0
            });
        }
    }

    // 4. Verify commands
    if (reply.verify.length > 0) {
        tasks.push({
            id: `task_${taskCounter++}_verify`,
            kind: 'verify',
            commands: [...reply.verify],
            dependsOnPrevious: tasks.length > 0
        });
    }

    return new TaskQueue(tasks);
}
