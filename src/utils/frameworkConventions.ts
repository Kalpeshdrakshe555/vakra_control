export class FrameworkConventions {
    private static conventions: Record<string, string> = {
        'next.js': `NEXT.JS ARCHITECTURE RULES:
- Routes: Use App Router ('src/app/' or 'app/').
- Components: Reusable UI goes in 'src/components/' or 'components/'.
- API: Serverless routes go in 'src/app/api/'.
- State/Utils: Use 'src/lib/' or 'src/utils/'.
- Database: Prisma models in 'prisma/schema.prisma'.`,

        'react': `REACT ARCHITECTURE RULES:
- Components: Reusable UI in 'src/components/'.
- Pages/Views: Route components in 'src/pages/' or 'src/views/'.
- Hooks: Custom hooks in 'src/hooks/'.
- State: Redux/Context in 'src/store/' or 'src/context/'.`,

        'django': `DJANGO ARCHITECTURE & TEMPLATE RULES:
- Handlers/Logic: Put views in 'views.py'.
- Database Models: Define in 'models.py'.
- Routing: Define URLs in 'urls.py' and include app in project root 'urls.py'.
- TEMPLATE NAMESPACING (CRITICAL FOR DJANGO):
  App templates MUST be nested inside an app-named directory:
  '<app_name>/templates/<app_name>/<template_name>.html'
  Example for 'catalog' app:
  * In views.py: render(request, 'catalog/product_list.html')
  * File on disk MUST be: 'catalog/templates/catalog/product_list.html'
  * DO NOT place directly at 'catalog/templates/product_list.html' (this causes TemplateDoesNotExist: catalog/product_list.html).
- Project-level Templates: If using a root 'templates/' folder, ensure 'settings.py' has:
  TEMPLATES = [{'BACKEND': 'django.template.backends.django.DjangoTemplates', 'DIRS': [BASE_DIR / 'templates'], 'APP_DIRS': True, ...}]
- App Registration: Ensure '<app_name>' is listed in INSTALLED_APPS in 'settings.py'.
- Static Files: Put in '<app_name>/static/<app_name>/'.
- Verification: Always run 'python manage.py check' to verify settings, models, and imports. Never run interactive 'manage.py shell'.`,

        'express': `EXPRESS ARCHITECTURE RULES:
- API Routes: Define in 'src/routes/'.
- Logic: Controllers go in 'src/controllers/'.
- Database: Models/Schemas in 'src/models/'.
- Middleware: Guards/interceptors in 'src/middleware/'.`,

        'flask': `FLASK ARCHITECTURE RULES:
- App Factory: Define app in 'app/__init__.py'.
- Routing: Use Blueprints in 'app/routes/'.
- Database Models: Define in 'app/models.py'.
- Templates: HTML in 'app/templates/'.`,

        'vue': `VUE ARCHITECTURE RULES:
- Components: Reusable UI in 'src/components/' (.vue files).
- Pages/Views: Route components in 'src/views/'.
- State: Pinia/Vuex stores in 'src/stores/'.
- Composables: Logic hooks in 'src/composables/'.`,

        'angular': `ANGULAR ARCHITECTURE RULES:
- Components: Use 'src/app/components/'.
- Services: Logic/API calls in 'src/app/services/'.
- Modules: Define feature modules in 'src/app/modules/'.
- Models: TypeScript interfaces in 'src/app/models/'.`
    };

    public static getConvention(framework?: string): string {
        if (!framework || framework === 'None' || framework === 'Unknown') return '';
        
        const key = framework.toLowerCase();
        for (const [fw, rules] of Object.entries(this.conventions)) {
            if (key.includes(fw)) {
                return rules;
            }
        }
        return '';
    }
}
