FROM python:3.11-slim

ARG PIP_VERSION=26.1.2
ARG SETUPTOOLS_VERSION=83.0.0
ARG WHEEL_VERSION=0.47.0

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=4000
ENV DJANGO_SETTINGS_MODULE=config.settings.production

WORKDIR /app

COPY requirements ./requirements
RUN python -m pip install --no-cache-dir --upgrade \
    "pip==${PIP_VERSION}" \
    "setuptools==${SETUPTOOLS_VERSION}" \
    "wheel==${WHEEL_VERSION}" \
  && python -m pip install --no-cache-dir -r requirements/production.txt

COPY src ./src
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x ./docker-entrypoint.sh \
  && addgroup --system --gid 1001 app \
  && adduser --system --uid 1001 --ingroup app appuser \
  && chown -R appuser:app /app

USER appuser

EXPOSE 4000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["sh", "-c", "gunicorn config.wsgi:application --chdir src --bind 0.0.0.0:${PORT:-4000} --workers 3"]
