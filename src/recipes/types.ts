// src/recipes/types.ts
// Contract definitions for deterministic framework recipes.

export type RecipeActionType = 'command' | 'write' | 'edit' | 'wire' | 'verify';

export interface RecipeStep {
    id: number;
    title: string;
    action: RecipeActionType;
    description: string;
    command?: string;
    targetPath?: string;
    doneCondition?: string; // e.g. 'exists:config/settings.py', 'integrity:django'
    docUrl?: string;
}

export interface RecipeDocReference {
    title: string;
    url: string;
    pitfall?: string;
}

export interface FrameworkRecipe {
    id: string; // e.g. 'django-web', 'django-drf-api', 'fastapi', 'react-vite', 'flask', 'node-express'
    name: string;
    description: string;
    keywords: string[];
    docs: RecipeDocReference[];
    steps: RecipeStep[];
}

