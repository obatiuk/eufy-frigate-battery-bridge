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

SRC_FILES := $(shell find $(PROJECT_ROOT)/src -type f -name '*.js')

.PHONY: check
check:
	@if command -v node >/dev/null 2>&1; then for f in $(SRC_FILES); do node --check "$$f" || exit 1; done; fi

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

.PHONY: print-vars
print-vars:
	@echo "PROJECT_NAME=$(PROJECT_NAME)"
	@echo "SRC_FILE=$(SRC_FILE)"
	@echo "BUILD_TAG=$(BUILD_TAG)"
	@echo "PUBLISH_TAG=$(PUBLISH_TAG)"
