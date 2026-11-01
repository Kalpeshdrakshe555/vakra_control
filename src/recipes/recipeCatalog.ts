// src/recipes/recipeCatalog.ts
// Pre-tested, deterministic framework recipes for reliable autonomous execution.

import { FrameworkRecipe, RecipeStep } from './types';

export class RecipeCatalog {
    private static readonly RECIPES: FrameworkRecipe[] = [
        {
            id: 'django-web',
            name: 'Django Web Application (Templates + Views)',
            description: 'Full-stack Django application with server-rendered HTML templates, models, and URL routing.',
            keywords: ['django', 'ecommerce', 'e-commerce', 'store', 'shop', 'blog', 'website', 'portal', 'dashboard'],
            docs: [
                {
                    title: 'Django Official Project Scaffolding',
                    url: 'https://docs.djangoproject.com/en/6.1/intro/tutorial01/',
                    pitfall: 'Always run django-admin startproject with a trailing dot (.) to avoid nested duplicate config directories.'
                },
                {
                    title: 'Django Settings & INSTALLED_APPS',
                    url: 'https://docs.djangoproject.com/en/6.1/ref/settings/#installed-apps',
                    pitfall: 'Never name custom apps "auth", "admin", or "django" as they collide with built-in Django packages.'
                },
                {
                    title: 'Django Templates Configuration',
                    url: 'https://docs.djangoproject.com/en/6.1/topics/templates/',
                    pitfall: 'TEMPLATES["DIRS"] must include BASE_DIR / "templates" if storing root-level template files.'
                },
                {
                    title: 'Django URL Dispatcher',
                    url: 'https://docs.djangoproject.com/en/6.1/topics/http/urls/',
                    pitfall: 'Ensure {% url "name" %} tags match the exact name parameter specified in path(..., name="...").'
                }
            ],
            steps: [
                {
                    id: 1,
                    title: 'Install and verify Django package',
                    action: 'command',
                    command: 'python -m pip install django',
                    description: 'Ensure Django is installed in the active Python environment.',
                    doneCondition: 'command:django'
                },
                {
                    id: 2,
                    title: 'Scaffold Django project structure at workspace root',
                    action: 'command',
                    command: 'django-admin startproject config .',
                    description: 'Initialize Django project with manage.py placed directly at workspace root.',
                    doneCondition: 'exists:manage.py'
                },
                {
                    id: 3,
                    title: 'Create primary application module',
                    action: 'command',
                    command: 'python manage.py startapp core',
                    description: 'Generate modular Django app (e.g. core, products, or store).',
                    doneCondition: 'exists:apps.py'
                },
                {
                    id: 4,
                    title: 'Register application in settings INSTALLED_APPS',
                    action: 'wire',
                    targetPath: 'config/settings.py',
                    description: 'Add newly created app to INSTALLED_APPS list in config/settings.py.',
                    doneCondition: 'integrity:installed_apps'
                },
                {
                    id: 5,
                    title: 'Configure template directories in settings',
                    action: 'wire',
                    targetPath: 'config/settings.py',
                    description: 'Set TEMPLATES["DIRS"] = [BASE_DIR / "templates"] in config/settings.py.',
                    doneCondition: 'integrity:templates_dirs'
                },
                {
                    id: 6,
                    title: 'Define data models and apply migrations',
                    action: 'write',
                    command: 'python manage.py makemigrations; python manage.py migrate',
                    description: 'Define application models and generate database schema.',
                    doneCondition: 'command:migrate'
                },
                {
                    id: 7,
                    title: 'Implement views rendering HTML templates',
                    action: 'write',
                    description: 'Create views returning render(request, "template.html", context).',
                    doneCondition: 'integrity:html_views'
                },
                {
                    id: 8,
                    title: 'Configure application and project URL routing',
                    action: 'wire',
                    description: 'Define app urls.py and include() in config/urls.py with matching view names.',
                    doneCondition: 'integrity:urls'
                },
                {
                    id: 9,
                    title: 'Create HTML templates matching view routes',
                    action: 'write',
                    targetPath: 'templates/',
                    description: 'Write base.html and page templates using standard Django template tags.',
                    doneCondition: 'exists:templates/base.html'
                },
                {
                    id: 10,
                    title: 'Run Django system check and verify integrity',
                    action: 'verify',
                    command: 'python manage.py check',
                    description: 'Execute official Django system check to confirm zero configuration or wiring errors.',
                    doneCondition: 'gate:manage_check'
                }
            ]
        },
        {
            id: 'django-drf-api',
            name: 'Django REST Framework (DRF) API',
            description: 'RESTful API with Django REST Framework, serializers, viewsets, and JSON endpoints.',
            keywords: ['rest', 'drf', 'api', 'djangorestframework', 'endpoint', 'json api'],
            docs: [
                {
                    title: 'Django REST Framework Quickstart',
                    url: 'https://www.django-rest-framework.org/tutorial/quickstart/',
                    pitfall: 'Both rest_framework and the app name MUST be added to INSTALLED_APPS in config/settings.py.'
                },
                {
                    title: 'DRF Serializers',
                    url: 'https://www.django-rest-framework.org/api-guide/serializers/',
                    pitfall: 'Ensure fields is specified as a tuple or "__all__" in ModelSerializer Meta class.'
                }
            ],
            steps: [
                {
                    id: 1,
                    title: 'Install Django and Django REST Framework',
                    action: 'command',
                    command: 'python -m pip install django djangorestframework',
                    description: 'Install django and djangorestframework packages via python -m pip.',
                    doneCondition: 'command:drf'
                },
                {
                    id: 2,
                    title: 'Scaffold Django project structure',
                    action: 'command',
                    command: 'django-admin startproject config .',
                    description: 'Initialize Django root project files.',
                    doneCondition: 'exists:manage.py'
                },
                {
                    id: 3,
                    title: 'Create API application',
                    action: 'command',
                    command: 'python manage.py startapp api',
                    description: 'Generate dedicated API application module.',
                    doneCondition: 'exists:api/apps.py'
                },
                {
                    id: 4,
                    title: 'Register rest_framework and api in settings',
                    action: 'wire',
                    targetPath: 'config/settings.py',
                    description: 'Add "rest_framework" and "api" to INSTALLED_APPS in settings.py.',
                    doneCondition: 'integrity:installed_apps'
                },
                {
                    id: 5,
                    title: 'Define models and execute database migrations',
                    action: 'write',
                    command: 'python manage.py makemigrations; python manage.py migrate',
                    description: 'Define entity models and apply database schema.',
                    doneCondition: 'command:migrate'
                },
                {
                    id: 6,
                    title: 'Create DRF ModelSerializers',
                    action: 'write',
                    targetPath: 'api/serializers.py',
                    description: 'Implement ModelSerializer classes with explicit Meta fields.',
                    doneCondition: 'exists:api/serializers.py'
                },
                {
                    id: 7,
                    title: 'Implement API ViewSets or APIViews',
                    action: 'write',
                    targetPath: 'api/views.py',
                    description: 'Write views handling CRUD operations or custom endpoints.',
                    doneCondition: 'exists:api/views.py'
                },
                {
                    id: 8,
                    title: 'Configure API URL routing with DefaultRouter',
                    action: 'wire',
                    targetPath: 'config/urls.py',
                    description: 'Register viewsets on DefaultRouter and include in root urls.py.',
                    doneCondition: 'integrity:urls'
                },
                {
                    id: 9,
                    title: 'Run Django system check and verify endpoints',
                    action: 'verify',
                    command: 'python manage.py check',
                    description: 'Verify configuration and API endpoint wiring.',
                    doneCondition: 'gate:manage_check'
                }
            ]
        },
        {
            id: 'fastapi',
            name: 'FastAPI Backend Service',
            description: 'Modern asynchronous REST API with FastAPI, Pydantic data schemas, and Uvicorn.',
            keywords: ['fastapi', 'uvicorn', 'pydantic', 'async api'],
            docs: [
                {
                    title: 'FastAPI First Steps',
                    url: 'https://fastapi.tiangolo.com/tutorial/first-steps/',
                    pitfall: 'Run with uvicorn main:app --reload or verify syntax with py_compile.'
                }
            ],
            steps: [
                {
                    id: 1,
                    title: 'Install FastAPI and Uvicorn',
                    action: 'command',
                    command: 'python -m pip install fastapi uvicorn',
                    description: 'Install dependencies using python -m pip.',
                    doneCondition: 'command:fastapi'
                },
                {
                    id: 2,
                    title: 'Define Pydantic request and response schemas',
                    action: 'write',
                    targetPath: 'schemas.py',
                    description: 'Create Pydantic BaseModel schemas for data validation.',
                    doneCondition: 'exists:schemas.py'
                },
                {
                    id: 3,
                    title: 'Implement API endpoints and router handlers',
                    action: 'write',
                    targetPath: 'routers/api.py',
                    description: 'Create APIRouter with typed endpoint handlers.',
                    doneCondition: 'exists:routers/api.py'
                },
                {
                    id: 4,
                    title: 'Configure main FastAPI application with CORS and routing',
                    action: 'write',
                    targetPath: 'main.py',
                    description: 'Instantiate FastAPI() in main.py, attach CORS middleware, and include routers.',
                    doneCondition: 'exists:main.py'
                },
                {
                    id: 5,
                    title: 'Verify Python syntax and entrypoint imports',
                    action: 'verify',
                    command: 'python -m py_compile main.py',
                    description: 'Ensure entrypoint has zero syntax errors or import issues.',
                    doneCondition: 'command:py_compile'
                }
            ]
        },
        {
            id: 'react-vite',
            name: 'React + Vite Frontend Application',
            description: 'Fast, modern React web application built with Vite and npm.',
            keywords: ['react', 'vite', 'frontend', 'ui', 'tailwind', 'single page'],
            docs: [
                {
                    title: 'Vite Getting Started',
                    url: 'https://vite.dev/guide/',
                    pitfall: 'Scaffold directly into root with npm create vite@latest . -- --template react to avoid nested directories.'
                }
            ],
            steps: [
                {
                    id: 1,
                    title: 'Scaffold Vite React project in workspace root',
                    action: 'command',
                    command: 'npm create vite@latest . -- --template react',
                    description: 'Scaffold project files directly at workspace root.',
                    doneCondition: 'exists:package.json'
                },
                {
                    id: 2,
                    title: 'Install project dependencies',
                    action: 'command',
                    command: 'npm install',
                    description: 'Run npm install to populate node_modules.',
                    doneCondition: 'exists:node_modules'
                },
                {
                    id: 3,
                    title: 'Implement UI components and layout',
                    action: 'write',
                    targetPath: 'src/components/',
                    description: 'Build functional React components for requested features.',
                    doneCondition: 'exists:src/components'
                },
                {
                    id: 4,
                    title: 'Configure application state and root App component',
                    action: 'edit',
                    targetPath: 'src/App.jsx',
                    description: 'Assemble components, state management, and props in App.jsx.',
                    doneCondition: 'exists:src/App.jsx'
                },
                {
                    id: 5,
                    title: 'Verify build with zero errors',
                    action: 'verify',
                    command: 'npm run build',
                    description: 'Execute Vite production build to prove zero bundling or syntax errors.',
                    doneCondition: 'command:build'
                }
            ]
        },
        {
            id: 'flask',
            name: 'Flask Lightweight Web Application',
            description: 'Lightweight Python web application or API using Flask.',
            keywords: ['flask', 'microframework', 'jinja'],
            docs: [
                {
                    title: 'Flask Quickstart',
                    url: 'https://flask.palletsprojects.com/en/latest/quickstart/',
                    pitfall: 'Ensure instance and template directories follow standard Flask layout.'
                }
            ],
            steps: [
                {
                    id: 1,
                    title: 'Install Flask dependency',
                    action: 'command',
                    command: 'python -m pip install flask',
                    description: 'Install flask package via python -m pip.',
                    doneCondition: 'command:flask'
                },
                {
                    id: 2,
                    title: 'Initialize Flask application and configuration',
                    action: 'write',
                    targetPath: 'app.py',
                    description: 'Create Flask app instance, configuration, and factory.',
                    doneCondition: 'exists:app.py'
                },
                {
                    id: 3,
                    title: 'Implement route handlers and business logic',
                    action: 'write',
                    targetPath: 'app.py',
                    description: 'Define routes, view functions, and response serializers.',
                    doneCondition: 'exists:app.py'
                },
                {
                    id: 4,
                    title: 'Create templates or static assets',
                    action: 'write',
                    targetPath: 'templates/index.html',
                    description: 'Create Jinja HTML templates if rendering web views.',
                    doneCondition: 'exists:templates'
                },
                {
                    id: 5,
                    title: 'Verify syntax and entrypoint integrity',
                    action: 'verify',
                    command: 'python -m py_compile app.py',
                    description: 'Verify that the Flask application file compiles cleanly.',
                    doneCondition: 'command:py_compile'
                }
            ]
        },
        {
            id: 'node-express',
            name: 'Node.js Express Backend API',
            description: 'REST API server using Node.js, Express, and JSON middleware.',
            keywords: ['express', 'node api', 'node server', 'expressjs'],
            docs: [
                {
                    title: 'Express Getting Started',
                    url: 'https://expressjs.com/en/starter/installing.html',
                    pitfall: 'Add express.json() middleware to correctly parse incoming JSON request bodies.'
                }
            ],
            steps: [
                {
                    id: 1,
                    title: 'Initialize package.json and install express',
                    action: 'command',
                    command: 'npm init -y; npm install express',
                    description: 'Initialize npm package manifest and install express.',
                    doneCondition: 'exists:package.json'
                },
                {
                    id: 2,
                    title: 'Implement Express server entrypoint and middleware',
                    action: 'write',
                    targetPath: 'src/index.js',
                    description: 'Create express instance, json middleware, and listen handler.',
                    doneCondition: 'exists:src/index.js'
                },
                {
                    id: 3,
                    title: 'Implement route handlers and controllers',
                    action: 'write',
                    targetPath: 'src/routes/',
                    description: 'Create modular express.Router() handlers.',
                    doneCondition: 'exists:src/routes'
                },
                {
                    id: 4,
                    title: 'Verify Node.js syntax and entrypoint',
                    action: 'verify',
                    command: 'node --check src/index.js',
                    description: 'Check JavaScript syntax with node --check.',
                    doneCondition: 'command:node_check'
                }
            ]
        }
    ];

    /**
     * Finds the most relevant recipe matching the user prompt and project requirements.
     */
    public static findRecipe(prompt: string): FrameworkRecipe | undefined {
        if (!prompt) return undefined;
        const lower = prompt.toLowerCase();

        // 1. Check for specific combinations first (e.g. Django + DRF/API)
        if (lower.includes('django') && (lower.includes('drf') || lower.includes('rest') || lower.includes('api') || lower.includes('rest_framework'))) {
            return this.getRecipeById('django-drf-api');
        }

        // 2. Django web template project
        if (lower.includes('django')) {
            return this.getRecipeById('django-web');
        }

        // 3. FastAPI
        if (lower.includes('fastapi') || (lower.includes('uvicorn') && lower.includes('api'))) {
            return this.getRecipeById('fastapi');
        }

        // 4. React / Vite
        if (lower.includes('react') || lower.includes('vite')) {
            return this.getRecipeById('react-vite');
        }

        // 5. Flask
        if (lower.includes('flask')) {
            return this.getRecipeById('flask');
        }

        // 6. Node / Express
        if (lower.includes('express') || lower.includes('node api') || lower.includes('node server')) {
            return this.getRecipeById('node-express');
        }

        return undefined;
    }

    /**
     * Retrieves a recipe by exact ID.
     */
    public static getRecipeById(id: string): FrameworkRecipe | undefined {
        return this.RECIPES.find(r => r.id === id);
    }

    /**
     * Returns all registered framework recipes.
     */
    public static getAllRecipes(): FrameworkRecipe[] {
        return [...this.RECIPES];
    }

    /**
     * Formats recipe steps into clean, atomic titles suitable for setMacroPlan.
     */
    public static formatRecipeStepTitles(recipe: FrameworkRecipe): string[] {
        return recipe.steps.map(s => `Step ${s.id}: ${s.title}`);
    }

    /**
     * Generates a structured RESEARCH.md document based on the recipe and task context.
     */
    public static generateResearchDoc(recipe: FrameworkRecipe, extraNotes?: string): string {
        let md = `# 🔬 Research & Framework Playbook: ${recipe.name}\n\n`;
        md += `> **Architecture Description:** ${recipe.description}\n\n`;

        md += `## 📚 Authoritative Documentation\n`;
        for (const doc of recipe.docs) {
            md += `- **[${doc.title}](${doc.url})**\n`;
            if (doc.pitfall) {
                md += `  - ⚠️ *Known Pitfall / Critical Rule:* ${doc.pitfall}\n`;
            }
        }
        md += '\n';

        md += `## 🛠️ Atomic Execution Sequence\n`;
        for (const step of recipe.steps) {
            md += `### Step ${step.id}: ${step.title}\n`;
            md += `- **Action Type:** \`${step.action}\`\n`;
            md += `- **Description:** ${step.description}\n`;
            if (step.command) {
                md += `- **CLI Command:** \`${step.command}\`\n`;
            }
            if (step.targetPath) {
                md += `- **Target File/Folder:** \`${step.targetPath}\`\n`;
            }
            if (step.doneCondition) {
                md += `- **Done Gate:** \`${step.doneCondition}\`\n`;
            }
            md += '\n';
        }

        if (extraNotes) {
            md += `## 💡 Project-Specific Requirements\n${extraNotes.trim()}\n\n`;
        }

        md += `---\n*Generated deterministically by Vakra AI Recipe Catalog.*`;
        return md;
    }
}
