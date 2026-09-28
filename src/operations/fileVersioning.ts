import * as fs from 'fs';
import * as path from 'path';

export class FileVersioning {
    public static createCheckpoint(workspaceRoot: string, label: string): string {
        const timestamp = Date.now();
        const cpDir = path.join(workspaceRoot, '.ultra-light-ai', 'checkpoints', `${timestamp}_${label.replace(/[^a-zA-Z0-9]/g, '_')}`);
        if (!fs.existsSync(cpDir)) {
            fs.mkdirSync(cpDir, { recursive: true });
        }
        return cpDir;
    }

    public static saveSnapshot(workspaceRoot: string, filepath: string, content: string): void {
        if (!fs.existsSync(filepath)) return; // Only snapshot existing files
        
        const snapshotsDir = path.join(workspaceRoot, '.ultra-light-ai', 'snapshots');
        if (!fs.existsSync(snapshotsDir)) fs.mkdirSync(snapshotsDir, { recursive: true });

        const relativePath = path.relative(workspaceRoot, filepath).replace(/[\\/]/g, '_');
        const timestamp = Date.now();
        
        const snapshotFile = path.join(snapshotsDir, `${timestamp}_${relativePath}`);
        fs.writeFileSync(snapshotFile, content, 'utf8');

        this.pruneOldSnapshots(snapshotsDir, relativePath, 10);
    }

    private static pruneOldSnapshots(snapshotsDir: string, relativePath: string, max: number): void {
        const files = fs.readdirSync(snapshotsDir).filter(f => f.endsWith(`_${relativePath}`));
        if (files.length <= max) return;

        // Sort by timestamp asc
        files.sort((a, b) => {
            const ta = parseInt(a.split('_')[0], 10);
            const tb = parseInt(b.split('_')[0], 10);
            return ta - tb;
        });

        // Delete oldest
        const toDelete = files.slice(0, files.length - max);
        for (const file of toDelete) {
            try { fs.unlinkSync(path.join(snapshotsDir, file)); } catch(e){}
        }
    }

    public static getLatestSnapshot(workspaceRoot: string, filepath: string): string | null {
        const snapshotsDir = path.join(workspaceRoot, '.ultra-light-ai', 'snapshots');
        if (!fs.existsSync(snapshotsDir)) return null;

        const relativePath = path.relative(workspaceRoot, filepath).replace(/[\\/]/g, '_');
        const files = fs.readdirSync(snapshotsDir).filter(f => f.endsWith(`_${relativePath}`));
        
        if (files.length === 0) return null;

        files.sort((a, b) => parseInt(b.split('_')[0], 10) - parseInt(a.split('_')[0], 10)); // desc
        
        try {
            const content = fs.readFileSync(path.join(snapshotsDir, files[0]), 'utf8');
            return content;
        } catch(e) {
            return null;
        }
    }
}
