// src/test/suite/recipes.test.ts
// Test suite for RecipeCatalog, Framework Recipes, Traceback Compressor, and Model Tier Resolution.

import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { RecipeCatalog } from '../../recipes/recipeCatalog';
import { RuntimePlugins } from '../../plugins/runtimePlugins';
import { resolveModelTier, isSmallModel } from '../../config/modelProfile';
import { InMemoryTaskPlanner } from '../../state/inMemoryTaskPlanner';

suite('Phase 5 & 6: Framework Recipes & Context Engineering Suite', () => {

    test('RecipeCatalog matches framework prompts correctly', () => {
        const djangoWeb = RecipeCatalog.findRecipe('Build an online e-commerce shop using Django');
        assert.ok(djangoWeb, 'Should find django-web recipe');
        assert.strictEqual(djangoWeb?.id, 'django-web');

        const djangoDrf = RecipeCatalog.findRecipe('Create a REST API with Django and DRF');
        assert.ok(djangoDrf, 'Should find django-drf-api recipe');
        assert.strictEqual(djangoDrf?.id, 'django-drf-api');

        const fastApi = RecipeCatalog.findRecipe('Build a FastAPI backend with uvicorn');
        assert.ok(fastApi, 'Should find fastapi recipe');
        assert.strictEqual(fastApi?.id, 'fastapi');

        const reactVite = RecipeCatalog.findRecipe('Create a React frontend using Vite');
        assert.ok(reactVite, 'Should find react-vite recipe');
        assert.strictEqual(reactVite?.id, 'react-vite');

        const flask = RecipeCatalog.findRecipe('Build a simple Flask application');
        assert.ok(flask, 'Should find flask recipe');
        assert.strictEqual(flask?.id, 'flask');

        const express = RecipeCatalog.findRecipe('Create an Express Node API server');
        assert.ok(express, 'Should find node-express recipe');
        assert.strictEqual(express?.id, 'node-express');

        const unrelated = RecipeCatalog.findRecipe('Calculate fibonacci numbers in Python');
        assert.strictEqual(unrelated, undefined, 'Unrelated prompt should return undefined');
    });

    test('Recipe steps adhere to atomic contracts', () => {
        const allRecipes = RecipeCatalog.getAllRecipes();
        assert.ok(allRecipes.length >= 6, 'Should define at least 6 framework recipes');

        for (const recipe of allRecipes) {
            assert.ok(recipe.id, 'Recipe must have an id');
            assert.ok(recipe.name, 'Recipe must have a name');
            assert.ok(recipe.docs.length > 0, `${recipe.id} must have doc references`);
            assert.ok(recipe.steps.length > 0, `${recipe.id} must have steps`);

            for (const step of recipe.steps) {
                assert.ok(['command', 'write', 'edit', 'wire', 'verify'].includes(step.action),
                    `Invalid action ${step.action} in step ${step.id} of ${recipe.id}`);
                assert.ok(step.title, `Step ${step.id} must have a title`);
                assert.ok(step.description, `Step ${step.id} must have a description`);
            }
        }
    });

    test('RecipeCatalog generates comprehensive RESEARCH.md document', () => {
        const recipe = RecipeCatalog.getRecipeById('django-web');
        assert.ok(recipe);
        const md = RecipeCatalog.generateResearchDoc(recipe, 'Build an e-commerce clothing store');

        assert.ok(md.includes('Research & Framework Playbook: Django Web Application'));
        assert.ok(md.includes('https://docs.djangoproject.com/'));
        assert.ok(md.includes('Known Pitfall'));
        assert.ok(md.includes('Step 1: Install and verify Django package'));
        assert.ok(md.includes('Build an e-commerce clothing store'));
    });

    test('compressTraceback collapses site-packages frames while preserving local frames and root exception', () => {
        const workspaceRoot = 'D:\\projects\\my_shop';
        const rawTraceback = [
            'Traceback (most recent call last):',
            '  File "C:\\Python312\\Lib\\site-packages\\django\\core\\handlers\\exception.py", line 55, in inner',
            '    response = get_response(request)',
            '  File "C:\\Python312\\Lib\\site-packages\\django\\core\\handlers\\base.py", line 197, in _get_response',
            '    response = wrapped_callback(request, *callback_args, **callback_kwargs)',
            `  File "${workspaceRoot}\\products\\views.py", line 12, in product_list`,
            "    return render(request, 'products.html', {'products': products})",
            '  File "C:\\Python312\\Lib\\site-packages\\django\\shortcuts.py", line 24, in render',
            '    content = loader.render_to_string(template_name, context, request, using=using)',
            '  File "C:\\Python312\\Lib\\site-packages\\django\\template\\loader.py", line 61, in render_to_string',
            '    template = get_template(template_name, using=using)',
            'django.template.exceptions.TemplateDoesNotExist: products.html'
        ];

        const compressed = RuntimePlugins.compressTraceback(rawTraceback, workspaceRoot);
        const compressedText = compressed.join('\n');

        // Check that external site-packages frames were collapsed cleanly
        assert.ok(compressedText.includes('external framework frames hidden'), 'Should hide library frames');

        // Check that local workspace frame was preserved
        assert.ok(compressedText.includes('products\\views.py", line 12, in product_list'), 'Must preserve workspace file frame');
        assert.ok(compressedText.includes("return render(request, 'products.html'"), 'Must preserve workspace code snippet');

        // Check that root cause exception was preserved
        assert.ok(compressedText.includes('TemplateDoesNotExist: products.html'), 'Must preserve the root error line');
    });

    test('resolveModelTier and isSmallModel identify model categories correctly', () => {
        assert.strictEqual(resolveModelTier('qwopus-4b'), 'small');
        assert.strictEqual(resolveModelTier('gemma-4-e4b'), 'small');
        assert.strictEqual(resolveModelTier('qwen2.5:3b'), 'small');
        assert.strictEqual(isSmallModel('qwopus-4b'), true);
        assert.strictEqual(isSmallModel('gemma:2b'), true);

        assert.strictEqual(resolveModelTier('qwen2.5-coder:7b'), 'medium');
        assert.strictEqual(resolveModelTier('mistral:7b'), 'medium');
        assert.strictEqual(resolveModelTier('llama3.1:8b'), 'medium');
        assert.strictEqual(isSmallModel('qwen2.5-coder:7b'), false);

        assert.strictEqual(resolveModelTier('claude-3-5-sonnet-20241022'), 'large');
        assert.strictEqual(resolveModelTier('gpt-4o'), 'large');
        assert.strictEqual(resolveModelTier('gemini-1.5-pro'), 'large');
        assert.strictEqual(resolveModelTier('deepseek-chat'), 'large');
        assert.strictEqual(isSmallModel('claude-3-5-sonnet-20241022'), false);
    });

    test('InMemoryTaskPlanner writes both PLAN.md and PLAN.json', () => {
        const testDir = path.join(__dirname, 'test_plan_sync_' + Date.now());
        fs.mkdirSync(testDir, { recursive: true });

        try {
            const planner = new InMemoryTaskPlanner(undefined, undefined);
            (planner as any).workspaceRoot = testDir;

            planner.setMacroPlan('Build Django store', [
                'Initialize Django project',
                'Create core application',
                'Verify with system check'
            ]);

            const planMdPath = path.join(testDir, 'PLAN.md');
            const planJsonPath = path.join(testDir, 'PLAN.json');

            assert.ok(fs.existsSync(planMdPath), 'PLAN.md should be written to workspace root');
            assert.ok(fs.existsSync(planJsonPath), 'PLAN.json should be written to workspace root');

            const jsonRaw = fs.readFileSync(planJsonPath, 'utf8');
            const parsed = JSON.parse(jsonRaw);
            assert.strictEqual(parsed.steps.length, 3);
            assert.strictEqual(parsed.steps[0].title, 'Initialize Django project');

            planner.clear();
            assert.ok(!fs.existsSync(planMdPath), 'PLAN.md should be unlinked on clear()');
            assert.ok(!fs.existsSync(planJsonPath), 'PLAN.json should be unlinked on clear()');
        } finally {
            try {
                fs.rmSync(testDir, { recursive: true, force: true });
            } catch {}
        }
    });
});

