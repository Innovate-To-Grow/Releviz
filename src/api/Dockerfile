FROM python:3.14-slim@sha256:cad9a2c871761c413caa6fdd6441c783451e740a48aaeba60ae62a8b53525ef6

ARG PIP_VERSION=26.1.2
ARG SETUPTOOLS_VERSION=83.0.0
ARG WHEEL_VERSION=0.47.0
ARG UTIL_LINUX_MIN_SOURCE_VERSION=2.41.5-0+deb13u1

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=4000
ENV DJANGO_SETTINGS_MODULE=config.settings.production

WORKDIR /app

COPY requirements ./requirements
RUN apt-get update \
  && apt-get upgrade -y \
  && for package in \
    bsdutils \
    libblkid1 \
    liblastlog2-2 \
    libmount1 \
    libsmartcols1 \
    libuuid1 \
    login \
    mount \
    util-linux; do \
      dpkg --compare-versions \
        "$(dpkg-query --show --showformat='${source:Version}' "${package}")" \
        ge "${UTIL_LINUX_MIN_SOURCE_VERSION}"; \
    done \
  && rm -rf /var/lib/apt/lists/* \
  && python -m pip install --no-cache-dir --upgrade \
    "pip==${PIP_VERSION}" \
    "setuptools==${SETUPTOOLS_VERSION}" \
    "wheel==${WHEEL_VERSION}" \
  && python -m pip install --no-cache-dir --require-hashes -r requirements/production.txt

COPY apps ./apps
COPY config ./config
COPY manage.py ./manage.py
COPY docker-entrypoint.sh ./docker-entrypoint.sh

RUN chmod +x ./docker-entrypoint.sh \
  && addgroup --system --gid 1001 app \
  && adduser --system --uid 1001 --ingroup app appuser \
  && chown -R appuser:app /app

USER appuser

EXPOSE 4000

ENTRYPOINT ["./docker-entrypoint.sh"]
# gunicorn manages the worker processes and uvicorn serves ASGI in each one,
# which lets Django stream the organizer event feed (a sync WSGI worker would
# buffer the whole response). gunicorn's own ASGI worker is not used: it drops
# a request that arrives on a kept-alive connection while Django is still
# finishing the previous one. Keep-alive stays above the ALB's 60 s idle
# timeout so the load balancer, not the worker, closes idle connections, and
# the graceful timeout stays under ECS's 30 s stop so a worker holding open
# streams exits before the SIGKILL.
CMD ["sh", "-c", "gunicorn config.asgi:application -k uvicorn_worker.UvicornWorker --bind 0.0.0.0:${PORT:-4000} --workers 3 --keep-alive 75 --graceful-timeout 10"]
