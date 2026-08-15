const core = require("@actions/core");
const github = require("@actions/github");
const { HttpClient } = require("@actions/http-client");
const fs = require("fs");
const path = require("path");

async function run() {
  const apiUrl = (core.getInput("api-url") || "https://api.archyl.com").replace(/\/+$/, "");
  const apiKey = core.getInput("api-key", { required: true });
  const organizationId = core.getInput("organization-id", { required: true });
  const projectId = core.getInput("project-id", { required: true });
  const failOn = core.getInput("fail-on") || "error";
  const commentOnPr = core.getInput("comment-on-pr") !== "false";
  const githubToken = core.getInput("github-token");
  const maxFileLines = parseInt(core.getInput("max-file-lines") || "200", 10);

  const http = new HttpClient("archyl-conformance-check-action");
  const headers = {
    "X-API-Key": apiKey,
    "X-Organization-ID": organizationId,
    "Content-Type": "application/json",
  };

  // Step 1: Get changed files from the PR or push
  const changedFiles = await getChangedFiles(githubToken);

  if (changedFiles.length === 0) {
    core.info("No changed files detected — skipping conformance check.");
    core.setOutput("total-violations", 0);
    core.setOutput("errors", 0);
    core.setOutput("warnings", 0);
    core.setOutput("infos", 0);
    core.setOutput("status", "pass");
    return;
  }

  core.info(`Found ${changedFiles.length} changed file(s).`);

  // Step 2: Read file contents (first N lines per file)
  const fileContents = readFileContents(changedFiles, maxFileLines);

  // Step 3: Run the conformance check. The API evaluates the whole diff in a
  // single call and returns the full report, so there is one check per run.
  core.info("Running conformance check...");

  const context = github.context;
  const body = {
    commitSha: context.payload.pull_request ? context.payload.pull_request.head.sha : context.sha,
    baseSha: context.payload.pull_request ? context.payload.pull_request.base.sha : context.payload.before || "",
    branch: context.payload.pull_request ? context.payload.pull_request.head.ref : context.ref.replace(/^refs\/heads\//, ""),
    changedFiles,
    fileContents,
  };

  const url = `${apiUrl}/api/v1/projects/${projectId}/conformance/check`;
  const response = await http.postJson(url, body, headers);

  if (response.statusCode < 200 || response.statusCode >= 300) {
    core.setFailed(`Conformance check failed: ${response.statusCode} ${JSON.stringify(response.result)}`);
    return;
  }

  const report = response.result || {};
  const checkId = report.check && report.check.id;
  const violations = report.violations || [];

  core.info(`Conformance check completed: ${checkId}`);

  // Step 4: Count by severity. Archyl grades violations critical/high/medium/low;
  // the action reports them on the error/warning/info scale used by `fail-on`.
  const counts = { error: 0, warning: 0, info: 0 };
  for (const v of violations) {
    counts[severityLevel(v.severity)]++;
  }

  const total = violations.length;

  core.setOutput("check-id", checkId);
  core.setOutput("total-violations", total);
  core.setOutput("errors", counts.error);
  core.setOutput("warnings", counts.warning);
  core.setOutput("infos", counts.info);

  // Step 5: Create annotations
  const ruleNames = ruleNameMap(report.rules);

  for (const v of violations) {
    const annotation = {
      file: v.filePath || undefined,
      startLine: v.lineStart || undefined,
      endLine: v.lineEnd || undefined,
    };

    const message = `[${ruleNames[v.ruleId] || "conformance"}] ${violationMessage(v)}`;

    const level = severityLevel(v.severity);
    if (level === "error") {
      core.error(message, annotation);
    } else if (level === "warning") {
      core.warning(message, annotation);
    } else {
      core.notice(message, annotation);
    }
  }

  // Step 6: Log summary
  core.info("");
  core.info("+" + "-".repeat(44) + "+");
  core.info(`|  Conformance Check: ${total === 0 ? "PASS" : `${total} violation(s)`}`.padEnd(45) + "|");
  core.info("+" + "-".repeat(44) + "+");
  core.info("");
  core.info(`  Errors:   ${counts.error}`);
  core.info(`  Warnings: ${counts.warning}`);
  core.info(`  Infos:    ${counts.info}`);
  core.info("");

  // Step 7: Write job summary
  const status = shouldFail(failOn, counts) ? "fail" : "pass";
  const emoji = status === "pass" ? "\u2705" : "\u274c";

  const summaryBuilder = core.summary
    .addHeading(`${emoji} Conformance Check: ${total} violation(s)`)
    .addRaw(`**${status === "pass" ? "Passed" : "Failed"}** — ${changedFiles.length} file(s) checked against architecture rules.\n\n`);

  if (total > 0) {
    const tableRows = [
      [
        { data: "Severity", header: true },
        { data: "Rule", header: true },
        { data: "File", header: true },
        { data: "Message", header: true },
      ],
    ];

    for (const v of violations) {
      tableRows.push([
        `${severityIcon(v.severity)} ${v.severity}`,
        ruleNames[v.ruleId] || "-",
        v.filePath ? `\`${v.filePath}\`` : "-",
        violationMessage(v) || "-",
      ]);
    }

    summaryBuilder.addTable(tableRows);
  }

  summaryBuilder.addRaw("\n\n---\n*Powered by [Archyl](https://archyl.com) — Architecture Intelligence for AI-Native Teams*\n");
  await summaryBuilder.write();

  core.setOutput("status", status);

  // Step 8: Comment on PR
  if (commentOnPr && github.context.payload.pull_request && githubToken) {
    await commentOnPullRequest(githubToken, violations, ruleNames, counts, changedFiles.length, status);
  }

  // Step 9: Fail if needed
  if (status === "fail") {
    core.setFailed(
      `Conformance check failed: ${counts.error} error(s), ${counts.warning} warning(s) (fail-on: ${failOn})`
    );
  }
}

async function getChangedFiles(token) {
  const context = github.context;

  if (context.payload.pull_request) {
    const octokit = github.getOctokit(token);
    const files = [];
    let page = 1;

    while (true) {
      const response = await octokit.rest.pulls.listFiles({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: context.payload.pull_request.number,
        per_page: 100,
        page,
      });

      for (const file of response.data) {
        files.push({
          path: file.filename,
          status: mapGitHubStatus(file.status),
        });
      }

      if (response.data.length < 100) break;
      page++;
    }

    return files;
  }

  // Fallback for push events: use before/after commits
  if (context.payload.before && context.payload.after) {
    const octokit = github.getOctokit(token);
    const response = await octokit.rest.repos.compareCommits({
      owner: context.repo.owner,
      repo: context.repo.repo,
      base: context.payload.before,
      head: context.payload.after,
    });

    return (response.data.files || []).map((file) => ({
      path: file.filename,
      status: mapGitHubStatus(file.status),
    }));
  }

  return [];
}

function mapGitHubStatus(ghStatus) {
  const map = {
    added: "added",
    modified: "modified",
    removed: "deleted",
    renamed: "modified",
    copied: "added",
    changed: "modified",
  };
  return map[ghStatus] || "modified";
}

function readFileContents(changedFiles, maxLines) {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const contents = {};

  for (const file of changedFiles) {
    if (file.status === "deleted") continue;

    const fullPath = path.join(workspace, file.path);
    if (!fs.existsSync(fullPath)) continue;

    try {
      const raw = fs.readFileSync(fullPath, "utf-8");
      const lines = raw.split("\n").slice(0, maxLines);
      contents[file.path] = lines.join("\n");
    } catch {
      core.warning(`Could not read file: ${file.path}`);
    }
  }

  return contents;
}

function ruleNameMap(rules) {
  const names = {};
  for (const rule of rules || []) {
    names[rule.id] = rule.name;
  }
  return names;
}

/**
 * Map an Archyl severity (critical, high, medium, low) onto the error/warning/info
 * scale that the `fail-on` input and the action outputs are expressed in.
 * critical and high both map to error, which matches the API's own `summary.passed`.
 */
function severityLevel(severity) {
  if (severity === "critical" || severity === "high") return "error";
  if (severity === "medium") return "warning";
  return "info";
}

function severityIcon(severity) {
  const level = severityLevel(severity);
  return level === "error" ? "🔴" : level === "warning" ? "🟠" : "🟢";
}

function violationMessage(v) {
  return v.suggestion ? `${v.title} — ${v.suggestion}` : v.title;
}

function shouldFail(failOn, counts) {
  if (failOn === "none") return false;
  if (failOn === "error") return counts.error > 0;
  if (failOn === "warning") return counts.error > 0 || counts.warning > 0;
  return counts.error > 0;
}

async function commentOnPullRequest(token, violations, ruleNames, counts, filesChecked, status) {
  try {
    const octokit = github.getOctokit(token);
    const context = github.context;
    const total = violations.length;
    const emoji = status === "pass" ? "\u2705" : "\u274c";

    let body = `## ${emoji} Archyl Conformance Check\n\n`;
    body += `**${filesChecked}** file(s) checked | `;
    body += `**${counts.error}** error(s) | **${counts.warning}** warning(s) | **${counts.info}** info(s)\n\n`;

    if (total > 0) {
      body += "| Severity | Rule | File | Message |\n";
      body += "|----------|------|------|---------|\n";

      for (const v of violations.slice(0, 25)) {
        body += `| ${severityIcon(v.severity)} ${v.severity} | ${ruleNames[v.ruleId] || "-"} | \`${v.filePath || "-"}\` | ${violationMessage(v) || "-"} |\n`;
      }

      if (total > 25) {
        body += `\n*...and ${total - 25} more violation(s). See the full report in Archyl.*\n`;
      }
    } else {
      body += "> All architecture conformance rules passed.\n";
    }

    body += "\n---\n*Powered by [Archyl](https://archyl.com) — Architecture Intelligence for AI-Native Teams*";

    // Update existing comment or create new one
    const comments = await octokit.rest.issues.listComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.payload.pull_request.number,
    });

    const existing = comments.data.find(
      (c) => c.body && c.body.includes("Archyl Conformance Check")
    );

    if (existing) {
      await octokit.rest.issues.updateComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        comment_id: existing.id,
        body,
      });
      core.info("Updated existing PR comment.");
    } else {
      await octokit.rest.issues.createComment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: context.payload.pull_request.number,
        body,
      });
      core.info("Created PR comment.");
    }
  } catch (err) {
    core.warning(`Failed to comment on PR: ${err.message}`);
  }
}

run().catch((err) => {
  core.setFailed(err.message);
});
