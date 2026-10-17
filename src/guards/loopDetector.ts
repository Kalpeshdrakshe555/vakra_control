import * as crypto from 'crypto';

export interface RecordedCall {
    tool: string;
    argsHash: string;
    resultOk: boolean;
    errorSig?: string;
    timestamp: number;
}

export class LoopDetector {
    private history: RecordedCall[] = [];
    private maxHistory: number = 8;
    private errorCounts: Map<string, number> = new Map();

    public static hashArgs(args: any): string {
        try {
            const normalized = JSON.stringify(args, Object.keys(args || {}).sort());
            return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 12);
        } catch {
            return 'nohash';
        }
    }

    public static computeErrorSig(errorMsg: string): string {
        if (!errorMsg) return '';
        // Extract first line, strip specific line numbers, memory addresses, timestamps
        const firstLine = errorMsg.split('\n')[0];
        return firstLine
            .replace(/[0-9]+/g, 'N')
            .replace(/0x[a-f0-9]+/gi, '0xHEX')
            .replace(/["'][^"']+["']/g, 'STR')
            .trim();
    }

    public record(call: { tool: string; argsHash: string; resultOk: boolean; errorSig?: string }): void {
        this.history.push({
            tool: call.tool,
            argsHash: call.argsHash,
            resultOk: call.resultOk,
            errorSig: call.errorSig,
            timestamp: Date.now()
        });

        if (this.history.length > this.maxHistory) {
            this.history.shift();
        }

        if (call.errorSig) {
            this.errorCounts.set(call.errorSig, (this.errorCounts.get(call.errorSig) || 0) + 1);
        }
    }

    public check(next: { tool: string; argsHash: string }): { repeat: boolean; message?: string } {
        if (this.history.length === 0) return { repeat: false };

        const last = this.history[this.history.length - 1];
        if (last.tool === next.tool && last.argsHash === next.argsHash && last.resultOk) {
            return {
                repeat: true,
                message: `You already executed tool '${next.tool}' with the exact same parameters successfully. Do not repeat identical actions; proceed to the next step.`
            };
        }

        return { repeat: false };
    }

    public sameErrorCount(sig: string): number {
        return this.errorCounts.get(sig) || 0;
    }

    public reset(): void {
        this.history = [];
        this.errorCounts.clear();
    }
}
