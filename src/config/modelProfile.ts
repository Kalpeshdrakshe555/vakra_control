import * as fs from 'fs';
import * as path from 'path';

export interface GeminiInputLimits {
    maxPacketKB: number;
    maxFilesPerPacket: number;
}

export interface PacingLimits {
    minDelayMs: number;
    maxDelayMs: number;
    maxSendsPerHour: number;
}

export interface ModelProfile {
    model: string;
    writeMode: 'extension' | 'model';
    maxFilesPerStep: number;
    maxLinesPerFile: number;
    maxCommandsPerStep: number;
    maxEditsPerFile: number;
    modelWriteLimitLines: number;
    geminiInput: GeminiInputLimits;
    maxReAsk: number;
    maxHelpRounds: number;
    pacing: PacingLimits;
}

export const DEFAULT_MODEL_PROFILE: ModelProfile = {
    model: 'qwopus-4b',
    writeMode: 'extension',
    maxFilesPerStep: 2,
    maxLinesPerFile: 400,
    maxCommandsPerStep: 5,
    maxEditsPerFile: 6,
    modelWriteLimitLines: 150,
    geminiInput: {
        maxPacketKB: 300,
        maxFilesPerPacket: 25
    },
    maxReAsk: 2,
    maxHelpRounds: 3,
    pacing: {
        minDelayMs: 1500,
        maxDelayMs: 4000,
        maxSendsPerHour: 60
    }
};

const profileCache = new Map<string, ModelProfile>();

/**
 * Validates and clamps a raw profile object, safely applying defaults.
 */
export function sanitizeProfile(raw: any): ModelProfile {
    if (!raw || typeof raw !== 'object') {
        return { ...DEFAULT_MODEL_PROFILE };
    }

    const writeMode: 'extension' | 'model' = raw.writeMode === 'model' ? 'model' : 'extension';
    const maxFilesPerStep = Math.max(1, Math.min(10, Number(raw.maxFilesPerStep) || DEFAULT_MODEL_PROFILE.maxFilesPerStep));
    const maxLinesPerFile = Math.max(50, Math.min(2000, Number(raw.maxLinesPerFile) || DEFAULT_MODEL_PROFILE.maxLinesPerFile));
    const maxCommandsPerStep = Math.max(1, Math.min(20, Number(raw.maxCommandsPerStep) || DEFAULT_MODEL_PROFILE.maxCommandsPerStep));
    const maxEditsPerFile = Math.max(1, Math.min(30, Number(raw.maxEditsPerFile) || DEFAULT_MODEL_PROFILE.maxEditsPerFile));
    const modelWriteLimitLines = Math.max(30, Math.min(500, Number(raw.modelWriteLimitLines) || DEFAULT_MODEL_PROFILE.modelWriteLimitLines));
    const maxReAsk = Math.max(0, Math.min(5, Number(raw.maxReAsk) || DEFAULT_MODEL_PROFILE.maxReAsk));
    const maxHelpRounds = Math.max(1, Math.min(10, Number(raw.maxHelpRounds) || DEFAULT_MODEL_PROFILE.maxHelpRounds));

    const geminiInput: GeminiInputLimits = {
        maxPacketKB: Math.max(50, Math.min(2000, Number(raw.geminiInput?.maxPacketKB) || DEFAULT_MODEL_PROFILE.geminiInput.maxPacketKB)),
        maxFilesPerPacket: Math.max(5, Math.min(100, Number(raw.geminiInput?.maxFilesPerPacket) || DEFAULT_MODEL_PROFILE.geminiInput.maxFilesPerPacket))
    };

    const pacing: PacingLimits = {
        minDelayMs: Math.max(500, Math.min(10000, Number(raw.pacing?.minDelayMs) || DEFAULT_MODEL_PROFILE.pacing.minDelayMs)),
        maxDelayMs: Math.max(1000, Math.min(20000, Number(raw.pacing?.maxDelayMs) || DEFAULT_MODEL_PROFILE.pacing.maxDelayMs)),
        maxSendsPerHour: Math.max(10, Math.min(300, Number(raw.pacing?.maxSendsPerHour) || DEFAULT_MODEL_PROFILE.pacing.maxSendsPerHour))
    };

    return {
        model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : DEFAULT_MODEL_PROFILE.model,
        writeMode,
        maxFilesPerStep,
        maxLinesPerFile,
        maxCommandsPerStep,
        maxEditsPerFile,
        modelWriteLimitLines,
        geminiInput,
        maxReAsk,
        maxHelpRounds,
        pacing
    };
}

/**
 * Loads the model profile for a workspace, caching in memory.
 */
export function getModelProfile(workspaceRoot?: string): ModelProfile {
    if (!workspaceRoot) return { ...DEFAULT_MODEL_PROFILE };

    if (profileCache.has(workspaceRoot)) {
        return profileCache.get(workspaceRoot)!;
    }

    const profileDir = path.join(workspaceRoot, '.ultra-light-ai');
    const profileFile = path.join(profileDir, 'model_profile.json');

    if (fs.existsSync(profileFile)) {
        try {
            const rawContent = fs.readFileSync(profileFile, 'utf8');
            const parsed = JSON.parse(rawContent);
            const sanitized = sanitizeProfile(parsed);
            profileCache.set(workspaceRoot, sanitized);
            return sanitized;
        } catch {
            // Bad JSON: return defaults and fallback gracefully
            const fallback = { ...DEFAULT_MODEL_PROFILE };
            profileCache.set(workspaceRoot, fallback);
            return fallback;
        }
    }

    const defaultProfile = { ...DEFAULT_MODEL_PROFILE };
    profileCache.set(workspaceRoot, defaultProfile);
    return defaultProfile;
}

/**
 * Categorizes a model into capability tiers: 'small' (<= 5B), 'medium' (7-14B), or 'large' (30B+ or cloud).
 */
export function resolveModelTier(modelName: string): 'small' | 'medium' | 'large' {
    if (!modelName) return 'small';
    const lower = modelName.toLowerCase();

    // 1. Explicit large / cloud indicators
    if (
        lower.includes('claude') ||
        lower.includes('gpt-4') ||
        lower.includes('gemini') ||
        lower.includes('deepseek-chat') ||
        lower.includes('deepseek-coder:33b') ||
        lower.includes('32b') ||
        lower.includes('70b') ||
        lower.includes('405b')
    ) {
        return 'large';
    }

    // 2. Explicit medium indicators (7B to 14B)
    if (
        lower.includes('7b') ||
        lower.includes('8b') ||
        lower.includes('13b') ||
        lower.includes('14b') ||
        lower.includes('mistral') ||
        lower.includes('qwen2.5-coder:7b')
    ) {
        return 'medium';
    }

    // 3. Explicit small indicators (<= 5B) or fallback default
    return 'small';
}

/**
 * Returns true if the model belongs to the small tier (<= 5B).
 */
export function isSmallModel(modelName?: string): boolean {
    return resolveModelTier(modelName || DEFAULT_MODEL_PROFILE.model) === 'small';
}

/**
 * Clears the profile cache.
 */
export function clearProfileCache(): void {
    profileCache.clear();
}
