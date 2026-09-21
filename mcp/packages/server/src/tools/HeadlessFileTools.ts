import { z } from "zod";
import "reflect-metadata";
import { EmptyToolArgs, Tool } from "../Tool";
import type { ToolResponse } from "../ToolResponse";
import { TextResponse } from "../ToolResponse";
import type { PenpotMcpServer } from "../PenpotMcpServer";
import type { HeadlessHost } from "../HeadlessHost";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Base for tools that act through the headless workspace host. They are only usable by
 * MCP sessions whose token belongs to the host's agent profile.
 */
abstract class HeadlessTool<TArgs extends object> extends Tool<TArgs> {
    protected constructor(
        mcpServer: PenpotMcpServer,
        protected readonly headless: HeadlessHost,
        schema: z.ZodRawShape
    ) {
        super(mcpServer, schema);
    }

    protected async requireHeadlessSession(): Promise<string> {
        const userToken = this.mcpServer.getSessionContext()?.userToken;
        if (!userToken || !(await this.headless.servesToken(userToken))) {
            throw new Error(
                "This MCP connection does not use the headless host's token. File tools are only available " +
                    "to the headless agent; with a personal token, open the file in Penpot in your browser instead."
            );
        }
        return userToken;
    }

    /**
     * Opens a file in the headless workspace and waits until the plugin reconnects to it.
     */
    protected async openAndWait(userToken: string, fileId: string, pageId?: string): Promise<string> {
        const previous = this.mcpServer.pluginBridge.getConnectionForToken(userToken);
        const status = await this.headless.open(fileId, pageId);
        const connected = await this.mcpServer.pluginBridge.waitForConnection(userToken, previous);
        if (!connected) {
            throw new Error(`Opened file ${fileId}, but the MCP plugin did not reconnect in time.`);
        }
        return `Opened "${status.file?.name}" (${status.file?.id}). Subsequent execute_code calls act on this file.`;
    }
}

class ListFilesTool extends HeadlessTool<EmptyToolArgs> {
    constructor(mcpServer: PenpotMcpServer, headless: HeadlessHost) {
        super(mcpServer, headless, EmptyToolArgs.schema);
    }

    public getToolName(): string {
        return "list_files";
    }

    public getToolDescription(): string {
        return (
            "Lists the Penpot teams, projects and files the headless agent can access, and which file is " +
            "currently open. Use the returned ids with open_file and create_file."
        );
    }

    protected async executeCore(): Promise<ToolResponse> {
        await this.requireHeadlessSession();
        const [{ teams }, status] = await Promise.all([this.headless.listFiles(), this.headless.status()]);
        return new TextResponse(JSON.stringify({ currentFile: status.file, teams }, null, 2));
    }
}

class OpenFileArgs {
    static schema = {
        fileId: z.string().regex(UUID, "must be a UUID").describe("Id of the file to open (see list_files)."),
        pageId: z.string().regex(UUID, "must be a UUID").optional().describe("Optional id of the page to open within the file."),
    };

    fileId!: string;
    pageId?: string;
}

class OpenFileTool extends HeadlessTool<OpenFileArgs> {
    constructor(mcpServer: PenpotMcpServer, headless: HeadlessHost) {
        super(mcpServer, headless, OpenFileArgs.schema);
    }

    public getToolName(): string {
        return "open_file";
    }

    public getToolDescription(): string {
        return (
            "Opens a Penpot file in the headless workspace, so that execute_code and the other design tools act " +
            "on it. Plugin `storage` is reset when the file changes."
        );
    }

    protected async executeCore(args: OpenFileArgs): Promise<ToolResponse> {
        const userToken = await this.requireHeadlessSession();
        return new TextResponse(await this.openAndWait(userToken, args.fileId, args.pageId));
    }
}

class CreateFileArgs {
    static schema = {
        name: z.string().min(1).max(250).describe("Name of the new file."),
        projectId: z
            .string()
            .regex(UUID, "must be a UUID")
            .optional()
            .describe("Id of an existing project to create the file in (see list_files)."),
        teamId: z
            .string()
            .regex(UUID, "must be a UUID")
            .optional()
            .describe("Id of the team in which to create a new project; required with projectName."),
        projectName: z
            .string()
            .min(1)
            .optional()
            .describe("Name of a new project to create for the file (instead of projectId)."),
        open: z.boolean().optional().describe("Open the new file in the headless workspace (default true)."),
    };

    name!: string;
    projectId?: string;
    teamId?: string;
    projectName?: string;
    open?: boolean;
}

class CreateFileTool extends HeadlessTool<CreateFileArgs> {
    constructor(mcpServer: PenpotMcpServer, headless: HeadlessHost) {
        super(mcpServer, headless, CreateFileArgs.schema);
    }

    public getToolName(): string {
        return "create_file";
    }

    public getToolDescription(): string {
        return (
            "Creates a new Penpot file, either in an existing project (projectId) or in a new project " +
            "(teamId + projectName), and by default opens it in the headless workspace."
        );
    }

    protected async executeCore(args: CreateFileArgs): Promise<ToolResponse> {
        const userToken = await this.requireHeadlessSession();
        let projectId = args.projectId;
        let projectNote = "";
        if (!projectId) {
            if (!args.teamId || !args.projectName) {
                throw new Error("Pass either projectId, or teamId together with projectName.");
            }
            const project = await this.headless.createProject(args.teamId, args.projectName);
            projectId = project.id;
            projectNote = `Created project "${project.name}" (${project.id}). `;
        }
        const file = await this.headless.createFile(projectId, args.name);
        let message = `${projectNote}Created file "${file.name}" (${file.id}).`;
        if (args.open !== false) {
            message += " " + (await this.openAndWait(userToken, file.id));
        }
        return new TextResponse(message);
    }
}

export class HeadlessFileTools {
    public static create(mcpServer: PenpotMcpServer, headless: HeadlessHost): Tool<any>[] {
        return [
            new ListFilesTool(mcpServer, headless),
            new OpenFileTool(mcpServer, headless),
            new CreateFileTool(mcpServer, headless),
        ];
    }
}
