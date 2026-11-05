MAKEFLAGS += --no-builtin-rules --no-builtin-variables --warn-undefined-variables
.DEFAULT_GOAL := docker-build
.DELETE_ON_ERROR:
.SUFFIXES:

SHELL := /bin/bash

MKFILE_PATH := $(abspath $(lastword $(MAKEFILE_LIST)))
PROJECT_ROOT := $(abspath $(dir $(MKFILE_PATH)))
SRC_FILE := $(PROJECT_ROOT)/src/app.js

DOCKER ?= /usr/bin/podman
TLS_VERIFY ?= false

PROJECT_NAME ?= $(notdir $(PROJECT_ROOT))
BUILD_VERSION ?= latest

BUILD_TAG ?= $(PROJECT_NAME):$(BUILD_VERSION)
REGISTRY ?=
PUBLISH_TAG ?= $(if $(strip $(REGISTRY)),$(patsubst %/,%,$(strip $(REGISTRY)))/$(BUILD_TAG),$(BUILD_TAG))
PUBLISH_TAG_ARG := $(if $(strip $(REGISTRY)),-t $(PUBLISH_TAG),)

NODE_VERSION ?= 22.16.0
HOST_OS := $(shell uname -s | tr '[:upper:]' '[:lower:]')
HOST_ARCH := $(shell uname -m | sed -e 's/x86_64/x64/' -e 's/aarch64/arm64/')
NODE_DIST := node-v$(NODE_VERSION)-$(HOST_OS)-$(HOST_ARCH)
NODE_URL := https://nodejs.org/dist/v$(NODE_VERSION)/$(NODE_DIST).tar.xz

VENV_DIR := $(PROJECT_ROOT)/.venv
NODE_DIR := $(VENV_DIR)/node
NODE_BIN := $(NODE_DIR)/bin/node
NPM_BIN := $(NODE_DIR)/bin/npm
NPM_CACHE_DIR := $(VENV_DIR)/npm-cache
NPM_USERCONFIG := $(VENV_DIR)/npmrc
VENV_HOME := $(VENV_DIR)/home
DEPS_STAMP := $(VENV_DIR)/.deps-installed

LOCAL_ENV := \
	PATH="$(NODE_DIR)/bin:$$PATH" \
	HOME="$(VENV_HOME)" \
	NODE_PATH="$(VENV_DIR)/node_modules" \
	NPM_CONFIG_CACHE="$(NPM_CACHE_DIR)" \
	NPM_CONFIG_USERCONFIG="$(NPM_USERCONFIG)" \
	NPM_CONFIG_UPDATE_NOTIFIER="false" \
	NPM_CONFIG_FUND="false" \
	NPM_CONFIG_AUDIT="false"

SRC_FILES := $(shell find $(PROJECT_ROOT)/src -type f -name '*.js')
TEST_FILES := $(shell find $(PROJECT_ROOT)/test -type f -name '*.test.js')
TEST_REPORTER := $(PROJECT_ROOT)/test/reporter.js

$(NODE_BIN):
	@mkdir -p "$(NODE_DIR)" "$(NPM_CACHE_DIR)" "$(VENV_HOME)"
	@curl -fsSL "$(NODE_URL)" | tar -xJ -C "$(NODE_DIR)" --strip-components=1

$(DEPS_STAMP): $(NODE_BIN) $(PROJECT_ROOT)/package.json
	@mkdir -p "$(NPM_CACHE_DIR)" "$(VENV_HOME)"
	@cp "$(PROJECT_ROOT)/package.json" "$(VENV_DIR)/package.json"
	@$(LOCAL_ENV) "$(NPM_BIN)" install --prefix "$(VENV_DIR)" --omit=dev --no-package-lock --no-audit --no-fund --silent
	@touch "$(DEPS_STAMP)"

.PHONY: env
env: $(DEPS_STAMP)

.PHONY: check
check: $(DEPS_STAMP)
	@for f in $(SRC_FILES) $(TEST_FILES) "$(TEST_REPORTER)"; do $(LOCAL_ENV) "$(NODE_BIN)" --check "$$f" || exit 1; done
	@$(LOCAL_ENV) "$(NODE_BIN)" --test --test-reporter="$(TEST_REPORTER)" $(TEST_FILES)

.PHONY: test
test: check

.PHONY: docker-build
docker-build: check
	@$(DOCKER) build --format docker -t $(BUILD_TAG) $(PUBLISH_TAG_ARG) $(PROJECT_ROOT)

.PHONY: publish
publish: docker-build
ifneq ($(strip $(REGISTRY)),)
	@$(DOCKER) push --tls-verify=$(TLS_VERIFY) $(PUBLISH_TAG)
endif

.PHONY: clean
clean:
	-@$(DOCKER) rmi $(PUBLISH_TAG) $(BUILD_TAG) 2>/dev/null || true
	@rm -rf "$(VENV_DIR)" "$(PROJECT_ROOT)/node_modules" "$(PROJECT_ROOT)/package-lock.json"

.PHONY: print-vars
print-vars:
	@echo "PROJECT_NAME=$(PROJECT_NAME)"
	@echo "SRC_FILE=$(SRC_FILE)"
	@echo "VENV_DIR=$(VENV_DIR)"
	@echo "NODE_BIN=$(NODE_BIN)"
	@echo "BUILD_TAG=$(BUILD_TAG)"
	@echo "PUBLISH_TAG=$(PUBLISH_TAG)"
