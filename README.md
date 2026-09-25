# Releviz

A meeting planner for large groups. Organizers import a roster, invite people, and collect weighted
availability for in-person and virtual meetings. Releviz then ranks the best continuous meeting
windows and sends calendar invitations for the one the organizer picks. One event supports up to
1,000 people and 1,000 time slots.

![Releviz Screenshot](Screenshoot.png)

## How it works

1. **Create an event.** Sign in, then set the meeting type, the daily time range and slot size, the
   meeting length, the days, and who can join. Block out any times that are never available.
2. **Build the roster.** Add people one at a time or import `.xlsx`/`.csv`, organize them into
   groups, and send invitations when you are ready.
3. **Collect availability.** Each participant paints Busy / If needed / Available on a schedule
   grid. The organizer can also enter a schedule for anyone who has not responded themselves.
4. **Pick a time.** The organizer dashboard ranks candidate windows by weighted availability, lets
   you include, exclude, or weight people and groups, and finalizes the meeting with an iCalendar
   invitation.

See the [user guide](docs/user-guide.md) for the full walkthrough.

## Tech stack

| Layer          | Technology                                                                   |
| -------------- | ---------------------------------------------------------------------------- |
| Frontend       | Next.js 16 static export, React 19, Bootstrap 5.3                            |
| Backend        | Django 6, Django REST Framework, SimpleJWT                                   |
| Database       | PostgreSQL (RDS) in production; SQLite for local development                 |
| Infrastructure | AWS Amplify (frontend); public ALB with private ECS Fargate API and workers  |
| IaC and CI/CD  | Terraform; GitHub Actions                                                    |

## Project structure

```
src/
  web/        # Next.js UI (static export, no API routes)
  api/        # Django API, authentication, and admin
  e2e/        # Playwright browser tests
infra/
  prod/       # Production Terraform
  bootstrap/  # Terraform state bucket and GitHub OIDC deploy roles
scripts/      # Quality gate, CI helpers, deploy helpers, DB and performance tools
docs/         # User guide, development, configuration, and deployment docs
```

## Local development

Requires Node.js 24 and Python 3.12–3.14. `npm run setup:api` recreates `src/api/.venv`; set
`PYTHON_BIN` if `python3` is not the right interpreter.

```bash
npm install
npm run setup:api
source src/api/.venv/bin/activate
python src/api/manage.py migrate --settings=config.settings.local
npm run dev             # backend on :4000 and frontend on :3000
npm run quality-gate    # lint, test, and build both workspaces
```

The result and email workers, individual test commands, and CI are covered in
[docs/development.md](docs/development.md).

## Documentation

- [User guide](docs/user-guide.md): events, rosters, invitations, availability, and results
- [Development](docs/development.md): local setup, background workers, tests, CI, and Docker
- [Configuration](docs/configuration.md): environment variables, authentication, and email delivery
- [Deployment](docs/deployment.md): the production release workflow and GitHub environment variables
- [Production bootstrap](infra/bootstrap/README.md): state bucket, deploy roles, secrets, and Amplify
  provisioning
