MAKEFLAGS += --no-builtin-rules --no-builtin-variables --warn-undefined-variables
.DELETE_ON_ERROR:
.SUFFIXES:
.DEFAULT_GOAL := help

SHELL := /bin/bash

# ======================================================================================================================
# Configuration
# ======================================================================================================================

MKFILE_PATH := $(realpath $(lastword $(MAKEFILE_LIST)))
PROJECT_ROOT := $(realpath $(dir $(MKFILE_PATH)))
DOCKERFILE := $(PROJECT_ROOT)/deploy/Dockerfile

DOCKER ?= /usr/bin/podman
TLS_VERIFY ?= false

PROJECT_NAME ?= $(notdir $(PROJECT_ROOT))
IMAGE_SOURCE := https://github.com/obatiuk/eufy-frigate-battery-bridge
BUILD_VERSION ?= $(shell git -C "$(PROJECT_ROOT)" describe --tags --exact-match 2>/dev/null || echo latest)
GIT_COMMIT ?= $(shell git -C "$(PROJECT_ROOT)" describe --always --dirty --exclude='*' 2>/dev/null || echo dev)

PUBLISH_TAG ?= latest
BUILD_TAG ?= $(PROJECT_NAME):$(BUILD_VERSION)
SECONDARY_TAG ?= $(PROJECT_NAME):$(PUBLISH_TAG)
SECONDARY_TAG_ARG := $(if $(filter-out $(PUBLISH_TAG),$(BUILD_VERSION)),-t $(SECONDARY_TAG),)
REGISTRY ?=
REGISTRY_PREFIX := $(patsubst %/,%,$(strip $(REGISTRY)))
REGISTRY_BUILD_TAG := $(if $(REGISTRY_PREFIX),$(REGISTRY_PREFIX)/$(BUILD_TAG),$(BUILD_TAG))
REGISTRY_SECONDARY_TAG := $(if $(REGISTRY_PREFIX),$(REGISTRY_PREFIX)/$(SECONDARY_TAG),$(SECONDARY_TAG))
REGISTRY_SECONDARY_ARG := $(if $(filter-out $(PUBLISH_TAG),$(BUILD_VERSION)),-t $(REGISTRY_SECONDARY_TAG),)
REGISTRY_TAG_ARG := $(if $(REGISTRY_PREFIX),-t $(REGISTRY_BUILD_TAG) $(REGISTRY_SECONDARY_ARG),)

NODE_VERSION ?= 22.16.0
HOST_OS := $(shell uname -s | tr '[:upper:]' '[:lower:]')
HOST_ARCH := $(shell uname -m | sed -e 's/x86_64/x64/' -e 's/aarch64/arm64/')
NODE_DIST := node-v$(NODE_VERSION)-$(HOST_OS)-$(HOST_ARCH)
NODE_URL := https://nodejs.org/dist/v$(NODE_VERSION)/$(NODE_DIST).tar.xz

VENV_DIR := $(PROJECT_ROOT)/.venv
TMP_DIR := $(PROJECT_ROOT)/.tmp
TEST_CACHE_DIR := $(TMP_DIR)/cache
NODE_DIR := $(VENV_DIR)/node
NODE_BIN := $(NODE_DIR)/bin/node
NPM_BIN := $(NODE_DIR)/bin/npm
TSC_BIN := $(VENV_DIR)/node_modules/.bin/tsc
KNIP_BIN := $(VENV_DIR)/node_modules/.bin/knip
ESLINT_BIN := $(VENV_DIR)/node_modules/.bin/eslint
PRETTIER_BIN := $(VENV_DIR)/node_modules/.bin/prettier
CODE_PATHS := src scripts test deploy package.json
DOC_PATHS := AGENTS.md README.md CHANGELOG.md docs .agents
LINT_PATHS := "$(PROJECT_ROOT)/src" "$(PROJECT_ROOT)/scripts" "$(PROJECT_ROOT)/test"
PRETTIER_FLAGS := --ignore-path "$(PROJECT_ROOT)/.gitignore" --ignore-unknown
MSG ?=
NPM_CACHE_DIR := $(VENV_DIR)/npm-cache
NPM_USERCONFIG := $(VENV_DIR)/npmrc
VENV_HOME := $(VENV_DIR)/home
DEPS_STAMP := $(VENV_DIR)/.deps-installed
TSCONFIG := $(PROJECT_ROOT)/scripts/tsconfig.json
ESLINT_CONFIG := $(PROJECT_ROOT)/scripts/eslint.config.js
ESLINT_SUPPRESSIONS := $(PROJECT_ROOT)/scripts/eslint-suppressions.json
ESLINT_ARGS := --config "$(ESLINT_CONFIG)" --suppressions-location "$(ESLINT_SUPPRESSIONS)"

LOCAL_ENV := \
	PATH="$(NODE_DIR)/bin:$$PATH" \
	HOME="$(VENV_HOME)" \
	TMPDIR="$(TMP_DIR)" \
	BRIDGE_CACHE_DIR="$(TEST_CACHE_DIR)" \
	NODE_PATH="$(VENV_DIR)/node_modules" \
	NPM_CONFIG_CACHE="$(NPM_CACHE_DIR)" \
	NPM_CONFIG_USERCONFIG="$(NPM_USERCONFIG)" \
	NPM_CONFIG_UPDATE_NOTIFIER="false" \
	NPM_CONFIG_FUND="false" \
	NPM_CONFIG_AUDIT="false"

SRC_FILES := $(shell find $(PROJECT_ROOT)/src -type f -name '*.js' | sort)
TEST_FILES := $(shell find $(PROJECT_ROOT)/test -type f -name '*.test.js' | sort)
ACCEPTANCE_TEST_FILES := $(sort $(wildcard $(PROJECT_ROOT)/test/acceptance/*.test.js))
REGRESSION_TEST_FILES := $(sort $(wildcard $(PROJECT_ROOT)/test/regression/*.test.js))
TEST_REPORTER := $(PROJECT_ROOT)/test/reporter.js
REGRESSION_TEST_PATTERN := ^Regression [0-9]+:
CHECK :=

# ======================================================================================================================
# Helpers
# ======================================================================================================================

$(TEST_CACHE_DIR):
	@install -d "$(TEST_CACHE_DIR)"

$(NODE_BIN):
	@install -d "$(NODE_DIR)" "$(NPM_CACHE_DIR)" "$(VENV_HOME)"
	@curl -fsSL "$(NODE_URL)" | tar -xJ -C "$(NODE_DIR)" --strip-components=1

$(DEPS_STAMP): $(PROJECT_ROOT)/package.json $(PROJECT_ROOT)/package-lock.json | $(NODE_BIN) $(TEST_CACHE_DIR)
	@install -d "$(NPM_CACHE_DIR)" "$(VENV_HOME)" "$(NODE_DIR)/lib" "$(TEST_CACHE_DIR)"
	@install -m 0644 "$(PROJECT_ROOT)/package.json" "$(VENV_DIR)/package.json"
	@install -m 0644 "$(PROJECT_ROOT)/package-lock.json" "$(VENV_DIR)/package-lock.json"
	@$(LOCAL_ENV) "$(NPM_BIN)" ci --prefix "$(VENV_DIR)" --no-audit --no-fund --silent
	@ln -sfn ../../node_modules "$(NODE_DIR)/lib/node"
	@touch "$(DEPS_STAMP)"

##@ Quality

CHECK += deadcode
.PHONY: deadcode
deadcode: ## Check static types (tsc) and unused code/exports (knip)
deadcode: | $(DEPS_STAMP) $(TEST_CACHE_DIR)
	@$(LOCAL_ENV) "$(TSC_BIN)" --project "$(TSCONFIG)"
	@$(LOCAL_ENV) "$(KNIP_BIN)" --directory "$(PROJECT_ROOT)" --tsConfig "$(TSCONFIG)" --no-progress

CHECK += lint
.PHONY: lint
lint: ## Run ESLint (structural + 120-col max-len) and Prettier code check
lint: | $(DEPS_STAMP) $(TEST_CACHE_DIR)
	@$(LOCAL_ENV) "$(ESLINT_BIN)" $(ESLINT_ARGS) $(LINT_PATHS)
	@cd "$(PROJECT_ROOT)" && $(LOCAL_ENV) "$(PRETTIER_BIN)" $(PRETTIER_FLAGS) --check $(CODE_PATHS)

.PHONY: lint-prune
lint-prune: ## Prune resolved entries from eslint-suppressions.json
lint-prune: | $(DEPS_STAMP) $(TEST_CACHE_DIR)
	@$(LOCAL_ENV) "$(ESLINT_BIN)" $(ESLINT_ARGS) --prune-suppressions $(LINT_PATHS)

.PHONY: lint-baseline
lint-baseline: ## Re-record current ESLint violations in eslint-suppressions.json
lint-baseline: | $(DEPS_STAMP) $(TEST_CACHE_DIR)
	@$(LOCAL_ENV) "$(ESLINT_BIN)" $(ESLINT_ARGS) --suppress-all $(LINT_PATHS) || true

CHECK += docs-check
.PHONY: docs-check
docs-check: ## Validate documentation rules, acceptance parity, and formatting
docs-check: | $(DEPS_STAMP) $(TEST_CACHE_DIR)
	@$(LOCAL_ENV) "$(NODE_BIN)" "$(PROJECT_ROOT)/scripts/check-docs.js"
	@cd "$(PROJECT_ROOT)" && $(LOCAL_ENV) "$(PRETTIER_BIN)" $(PRETTIER_FLAGS) --check $(DOC_PATHS)

.PHONY: format
format: ## Format code, JSON/YAML configs, and Markdown documentation with Prettier
format: | $(DEPS_STAMP) $(TEST_CACHE_DIR)
	@cd "$(PROJECT_ROOT)" && $(LOCAL_ENV) "$(PRETTIER_BIN)" $(PRETTIER_FLAGS) --write $(CODE_PATHS) $(DOC_PATHS)

.PHONY: format-docs
format-docs: ## Format Markdown documentation files with Prettier
format-docs: | $(DEPS_STAMP) $(TEST_CACHE_DIR)
	@cd "$(PROJECT_ROOT)" && $(LOCAL_ENV) "$(PRETTIER_BIN)" $(PRETTIER_FLAGS) --write $(DOC_PATHS)

.PHONY: commit-msg-check
commit-msg-check: ## Validate a commit message file (MSG=<path>)
commit-msg-check: | $(DEPS_STAMP) $(TEST_CACHE_DIR)
	@test -n "$(MSG)" || { echo "usage: make commit-msg-check MSG=<message-file>"; exit 2; }
	@$(LOCAL_ENV) "$(NODE_BIN)" "$(PROJECT_ROOT)/scripts/check-commit-msg.js" "$(MSG)"

CHECK += test
.PHONY: test
test: ## Run syntax checks and acceptance/unit test suites
test: | $(DEPS_STAMP) $(TEST_CACHE_DIR)
	@printf '%s\0' $(SRC_FILES) $(TEST_FILES) "$(TEST_REPORTER)" \
		| $(LOCAL_ENV) xargs -0 -n 1 -P 8 "$(NODE_BIN)" --check
	@$(LOCAL_ENV) "$(NODE_BIN)" --test --test-reporter="$(TEST_REPORTER)" $(TEST_FILES)

.PHONY: test-acceptance
test-acceptance: ## Run the locked acceptance suite (test/acceptance/*.test.js)
test-acceptance: | $(DEPS_STAMP) $(TEST_CACHE_DIR)
	@$(LOCAL_ENV) "$(NODE_BIN)" --test --test-reporter="$(TEST_REPORTER)" $(ACCEPTANCE_TEST_FILES)

.PHONY: test-regression
test-regression: ## Run the ordered regression suite (test/regression/*.test.js)
test-regression: | $(DEPS_STAMP) $(TEST_CACHE_DIR)
	@$(LOCAL_ENV) "$(NODE_BIN)" --test --test-reporter="$(TEST_REPORTER)" \
		--test-name-pattern="$(REGRESSION_TEST_PATTERN)" $(REGRESSION_TEST_FILES)

##@ Build

.PHONY: docker-build
docker-build: ## Run checks and build the container image
docker-build: check
	@$(DOCKER) build --format docker \
		--build-arg BUILD_VERSION="$(BUILD_VERSION)" \
		--build-arg GIT_COMMIT="$(GIT_COMMIT)" \
		-f "$(DOCKERFILE)" -t $(BUILD_TAG) $(SECONDARY_TAG_ARG) $(REGISTRY_TAG_ARG) $(PROJECT_ROOT)

.PHONY: publish
publish: ## Build and push the container image when REGISTRY is set
publish: docker-build
ifneq ($(REGISTRY_PREFIX),)
	@$(DOCKER) push --tls-verify=$(TLS_VERIFY) $(REGISTRY_BUILD_TAG)
ifneq ($(BUILD_VERSION),$(PUBLISH_TAG))
	@$(DOCKER) push --tls-verify=$(TLS_VERIFY) $(REGISTRY_SECONDARY_TAG)
endif
endif

##@ General

.PHONY: help
help: ## Display this help message
	@awk 'BEGIN {FS = ":.*##"; printf "Usage:\033[36m\033[0m\n"} \
	/^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2 } \
	/^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' \
	$(MAKEFILE_LIST)

.PHONY: env
env: ## Bootstrap the hermetic .venv Node.js toolchain
env: | $(DEPS_STAMP)

.PHONY: check
check: ## Run all quality gates (deadcode, lint, docs-check, test)
check: $(CHECK)

.PHONY: install-hooks
install-hooks: ## Install the git commit-msg validation hook
install-hooks: | $(DEPS_STAMP)
	@install -d "$(PROJECT_ROOT)/.git/hooks"
	@printf '#!/bin/sh\nexec "%s" "%s/scripts/check-commit-msg.js" "$$1"\n' \
		"$(NODE_BIN)" "$(PROJECT_ROOT)" > "$(PROJECT_ROOT)/.git/hooks/commit-msg"
	@chmod 0755 "$(PROJECT_ROOT)/.git/hooks/commit-msg"

.PHONY: clean
clean: ## Remove local container images, build cache, .tmp, and .venv
	-@$(DOCKER) rmi $(REGISTRY_BUILD_TAG) $(REGISTRY_SECONDARY_TAG) $(BUILD_TAG) $(SECONDARY_TAG) 2>/dev/null || true
	-@$(DOCKER) image prune -a -f \
		--filter "label=org.opencontainers.image.source=$(IMAGE_SOURCE)" 2>/dev/null || true
	@rm -rf "$(TMP_DIR)" "$(VENV_DIR)" "$(PROJECT_ROOT)/node_modules"

.PHONY: print-vars
print-vars: ## Print resolved build and toolchain variables
	@echo "PROJECT_NAME=$(PROJECT_NAME)"
	@echo "DOCKERFILE=$(DOCKERFILE)"
	@echo "VENV_DIR=$(VENV_DIR)"
	@echo "TMP_DIR=$(TMP_DIR)"
	@echo "NODE_BIN=$(NODE_BIN)"
	@echo "BUILD_TAG=$(BUILD_TAG)"
	@echo "PUBLISH_TAG=$(PUBLISH_TAG)"
	@echo "REGISTRY_BUILD_TAG=$(REGISTRY_BUILD_TAG)"
	@echo "REGISTRY_SECONDARY_TAG=$(REGISTRY_SECONDARY_TAG)"
	@echo "BUILD_VERSION=$(BUILD_VERSION)"
	@echo "GIT_COMMIT=$(GIT_COMMIT)"
