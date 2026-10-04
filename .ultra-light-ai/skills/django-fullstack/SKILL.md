---
name: "django-fullstack"
description: "End-to-end production Django feature development and verification"
trigger_rules: ["django", "models.py", "create app", "crud", "full-stack", "manage.py", "urls.py"]
---

GOAL: Build or extend a Django application end-to-end without breaking routing or imports.

PRECONDITIONS:
- Inspect BLUEPRINT.md first. Reuse existing models, apps, and url patterns.

CHECKLIST (Execute one step per turn, in strict order):
1. `list_directory_tree`: Inspect existing apps and manage.py location.
2. If starting a new app: `execute_terminal_command("python manage.py startapp <app_name>")`.
3. `edit_file`: Add `<app_name>` into `INSTALLED_APPS` inside `settings.py`.
4. `write_file` or `edit_file`: Define models in `<app_name>/models.py`.
5. `execute_terminal_command`: Run `python manage.py makemigrations && python manage.py migrate`.
6. `write_file`: Create class-based or function views in `<app_name>/views.py`.
7. `write_file`: Create app routes in `<app_name>/urls.py` with `app_name = '<app_name>'`.
8. `edit_file`: Connect `<app_name>.urls` into main project's root `urls.py`.
9. `write_file`: Create HTML templates inside `<app_name>/templates/<app_name>/`.
10. VERIFY: `execute_terminal_command("python manage.py check")`.
11. If check passes with 0 errors: call `finish(summary="...")`. If errors exist: inspect traceback, fix ONE file, and rerun step 10.

NEVER:
- Never run blocking `python manage.py runserver`.
- Never dump code in chat.
- Never skip migration step 5 after model changes.
