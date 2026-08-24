export class DomainError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly statusCode: number,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = new.target.name;
    }
}

export class NotFoundError extends DomainError {
    constructor(resource: string, id: string) {
        super("not_found", `${resource} '${id}' was not found`, 404);
    }
}

export class ConflictError extends DomainError {
    constructor(code: string, message: string) {
        super(code, message, 409);
    }
}

export class VersionConflictError extends ConflictError {
    constructor(resource: string, expected: number, actual: number) {
        super(
            "version_conflict",
            `${resource} version conflict: expected version ${String(expected)}, current version is ${String(actual)}`,
        );
    }
}

export class PreconditionRequiredError extends DomainError {
    constructor(header: string) {
        super("precondition_required", `Header '${header}' is required`, 428);
    }
}

export class UnauthorizedError extends DomainError {
    constructor() {
        super("unauthorized", "A valid Lowcoder administration bearer token is required", 401);
    }
}

export class ConnectorUnauthorizedError extends DomainError {
    constructor() {
        super("connector_unauthorized", "A valid Hermes Connector registration token is required", 401);
    }
}
