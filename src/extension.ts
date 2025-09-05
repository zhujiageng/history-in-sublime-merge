import * as vscode from "vscode";
import * as child from "child_process";
import * as findUp from "find-up";
import * as path from "path";
import * as fs from "fs";

type FileDetails = {
  path: string;
  selectionStart: number;
  selectionEnd: number;
  repository: string;
};

let SMERGE_BINARY_PATH: string;

const getRepository = async (
  element: string,
  elementType: "file" | "directory"
): Promise<string | undefined> => {
  const startDir = elementType === "file" ? path.dirname(element) : element;

  // 递归向上查找，优先处理子模块情况
  let currentDir = startDir;
  const rootPath = path.parse(element).root; // 获取根路径，避免无限循环

  while (currentDir !== rootPath) {
    const currentGitFile = path.join(currentDir, ".git");

    if (fs.existsSync(currentGitFile)) {
      const stat = fs.statSync(currentGitFile);

      if (stat.isFile()) {
        // 找到 .git 文件，这是子模块
        try {
          // 读取 .git 文件内容
          const gitFileContent = fs.readFileSync(currentGitFile, "utf8").trim();
          console.log(
            `Found .git file at ${currentGitFile}, content: ${gitFileContent}`
          );

          // 解析 .git 文件内容
          // 格式通常是: gitdir: <path> 或 <path>
          let gitDirPath: string;
          if (gitFileContent.startsWith("gitdir: ")) {
            gitDirPath = gitFileContent.substring(8).trim();
          } else {
            gitDirPath = gitFileContent;
          }

          // 如果是相对路径，则相对于 .git 文件所在目录
          if (!path.isAbsolute(gitDirPath)) {
            gitDirPath = path.resolve(path.dirname(currentGitFile), gitDirPath);
          }

          console.log(`Resolved git directory path: ${gitDirPath}`);

          // 检查解析出的路径是否存在且是目录
          if (
            fs.existsSync(gitDirPath) &&
            fs.statSync(gitDirPath).isDirectory()
          ) {
            const repoPath = path.dirname(gitDirPath);
            console.log(`Using submodule repository: ${repoPath}`);
            return repoPath;
          }
        } catch (error) {
          console.warn("Failed to parse .git file:", error);
        }
      } else if (stat.isDirectory()) {
        // 找到 .git 目录，这是普通仓库
        const repoPath = path.dirname(currentGitFile);
        console.log(`Using regular repository: ${repoPath}`);
        return repoPath;
      }
    }

    // 继续向上查找
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      // 已经到达根目录
      break;
    }
    currentDir = parentDir;
  }

  // 如果没有找到任何 .git 文件或目录
  vscode.window.showWarningMessage("Unable to resolve the repository to open.");

  return;
};

const openSublimeMerge = (args: string[], repository: string): void => {
  const customPath = vscode.workspace
    .getConfiguration()
    .get<string>("history-in-sublime-merge.path");

  const binaryPath = customPath || SMERGE_BINARY_PATH;

  console.log(`=== Sublime Merge Command ===`);
  console.log(`Binary path: ${binaryPath}`);
  console.log(`Arguments: ${JSON.stringify(args)}`);
  console.log(`Working directory: ${repository}`);
  console.log(`Full command: ${binaryPath} ${args.join(" ")}`);
  console.log(`=============================`);

  child.execFile(binaryPath, args, {
    cwd: repository,
  });
};

const getFileDetails = async (
  editor: vscode.TextEditor
): Promise<FileDetails | undefined> => {
  const repository = await getRepository(editor.document.uri.path, "file");

  if (!repository) {
    return;
  }

  // 计算文件相对于仓库的路径
  let relativePath = editor.document.uri.path.replace(`${repository}/`, "");

  // 如果文件在子模块中，需要调整路径和工作目录
  // 递归向上查找子模块的根目录
  let currentDir = path.dirname(editor.document.uri.path);
  let submoduleRoot = null;

  while (currentDir !== path.parse(editor.document.uri.path).root) {
    const currentGitFile = path.join(currentDir, ".git");
    if (fs.existsSync(currentGitFile) && fs.statSync(currentGitFile).isFile()) {
      submoduleRoot = currentDir;
      break;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  if (submoduleRoot) {
    // 这是子模块中的文件，使用子模块根目录作为工作目录
    // 计算文件相对于子模块根目录的路径
    relativePath = path.relative(submoduleRoot, editor.document.uri.path);

    return {
      path: relativePath,
      selectionStart: editor.selection.start.line + 1,
      selectionEnd: editor.selection.end.line + 1,
      repository: submoduleRoot, // 使用子模块根目录作为工作目录
    };
  }

  return {
    path: relativePath,
    selectionStart: editor.selection.start.line + 1,
    selectionEnd: editor.selection.end.line + 1,
    repository: repository ?? "",
  };
};

const openRepository = async (): Promise<void> => {
  let repository: string | undefined;

  if (vscode.workspace.workspaceFolders?.length === 1) {
    repository = await getRepository(
      vscode.workspace.workspaceFolders[0].uri.path,
      "directory"
    );
  } else if (vscode.window.activeTextEditor) {
    repository = (await getFileDetails(vscode.window.activeTextEditor))
      ?.repository;
  } else {
    vscode.window.showWarningMessage(
      "Unable to resolve the repository to open."
    );
  }

  if (!repository) {
    return;
  }

  openSublimeMerge(["."], repository);
};

const openFile = async (
  file: vscode.Uri,
  action: "search" | "blame"
): Promise<void> => {
  const filePath = file.path;

  if (!filePath) {
    vscode.window.showWarningMessage("Unable to resolve the file's path.");
    return;
  }

  const repository = await getRepository(filePath, "file");

  if (!repository) {
    return;
  }

  // 计算文件相对于仓库的路径
  let relativePath = filePath.replace(`${repository}/`, "");

  // 如果文件在子模块中，需要调整路径和工作目录
  // 递归向上查找子模块的根目录
  let currentDir = path.dirname(filePath);
  let submoduleRoot = null;

  while (currentDir !== path.parse(filePath).root) {
    const currentGitFile = path.join(currentDir, ".git");
    if (fs.existsSync(currentGitFile) && fs.statSync(currentGitFile).isFile()) {
      submoduleRoot = currentDir;
      break;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  let workingDir = repository;
  if (submoduleRoot) {
    // 这是子模块中的文件，使用子模块根目录作为工作目录
    workingDir = submoduleRoot;
    // 计算文件相对于子模块根目录的路径
    relativePath = path.relative(submoduleRoot, filePath);
  }

  const searchPattern =
    action === "search" ? `file:"${relativePath}"` : relativePath;

  console.log(`=== openFile Debug ===`);
  console.log(`File path: ${filePath}`);
  console.log(`Repository: ${repository}`);
  console.log(`Working directory: ${workingDir}`);
  console.log(`Relative path: ${relativePath}`);
  console.log(`Search pattern: ${searchPattern}`);
  console.log(`=====================`);

  openSublimeMerge([action, searchPattern], workingDir);
};

const viewLineHistory = async (): Promise<void> => {
  if (vscode.window.activeTextEditor) {
    const fileDetails = await getFileDetails(vscode.window.activeTextEditor);

    if (!fileDetails) {
      return;
    }

    openSublimeMerge(
      [
        "search",
        `file:"${fileDetails.path}" line:${fileDetails.selectionStart}-${fileDetails.selectionEnd}`,
      ],
      fileDetails.repository
    );
  }
};

const getSmergeBinaryPath = () => {
  switch (process.platform) {
    case "win32":
      return "smerge";
    case "darwin":
      return "/Applications/Sublime Merge.app/Contents/SharedSupport/bin/smerge";
    default:
      return "/opt/sublime_merge/sublime_merge";
  }
};

export const activate = (context: vscode.ExtensionContext): void => {
  const extensionName = "history-in-sublime-merge";
  SMERGE_BINARY_PATH = getSmergeBinaryPath();

  context.subscriptions.push(
    vscode.commands.registerCommand(
      `${extensionName}.openRepository`,
      openRepository
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      `${extensionName}.viewFileHistory`,
      (file) => openFile(file, "search")
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      `${extensionName}.viewLineHistory`,
      viewLineHistory
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(`${extensionName}.blameFile`, (file) =>
      openFile(file, "blame")
    )
  );
};

export const deactivate = (): void => {};
