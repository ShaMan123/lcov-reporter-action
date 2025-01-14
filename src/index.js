import core from "@actions/core"
import { context, getOctokit } from "@actions/github"
import { promises as fs } from "fs"
import path from "path"
import { diff } from "./comment"
import { deleteOldComments, getExistingComments } from "./delete_old_comments"
import { getChangedFiles } from "./get_changes"
import { parse } from "./lcov"
import { normalisePath } from "./util"

const MAX_COMMENT_CHARS = 65536

async function main() {
	const token = core.getInput("github-token")
	const githubClient = getOctokit(token).rest
	const workingDir = core.getInput("working-directory") || "./"
	const lcovFile = path.join(
		workingDir,
		core.getInput("lcov-file") || "./coverage/lcov.info",
	)
	const baseFile = core.getInput("lcov-base")
	const shouldFilterChangedFiles =
		core.getInput("filter-changed-files").toLowerCase() === "true"
	const shouldDeleteOldComments =
		core.getInput("delete-old-comments").toLowerCase() === "true"
	const shouldUpdateLastComment =
		core.getInput("update-comment").toLowerCase() === "true"
	const title = core.getInput("title")
	const prepend = core.getInput("comment_prepend") || ""
	const append = core.getInput("comment_append") || ""

	const raw = await fs.readFile(lcovFile, "utf-8").catch((err) => null)
	if (!raw) {
		console.log(`No coverage report found at '${lcovFile}', exiting...`)
		return
	}

	const baseRaw =
		baseFile && (await fs.readFile(baseFile, "utf-8").catch((err) => null))
	if (baseFile && !baseRaw) {
		console.log(`No coverage report found at '${baseFile}', ignoring...`)
	}

	const options = {
		repository: context.payload.repository.full_name,
		prefix: normalisePath(`${process.env.GITHUB_WORKSPACE}/`),
		workingDir,
	}

	if (context.eventName === "pull_request") {
		options.commit = context.payload.pull_request.head.sha
		options.baseCommit = context.payload.pull_request.base.sha
		options.head = context.payload.pull_request.head.ref
		options.base = context.payload.pull_request.base.ref
	} else if (context.eventName === "push") {
		options.commit = context.payload.after
		options.baseCommit = context.payload.before
		options.head = context.ref
	}

	options.shouldFilterChangedFiles = shouldFilterChangedFiles
	options.title = title

	if (shouldFilterChangedFiles) {
		options.changedFiles = await getChangedFiles(githubClient, options, context)
	}

	const lcov = await parse(raw)
	const baselcov = baseRaw && (await parse(baseRaw))
	const reportMaxChars = MAX_COMMENT_CHARS - prepend.length - append.length - 4
	const body = `${prepend}\n\n${diff(lcov, baselcov, options).substring(
		0,
		reportMaxChars,
	)}\n\n${append}`
	let commentToUpdate
	if (shouldDeleteOldComments) {
		commentToUpdate = await deleteOldComments(
			githubClient,
			options,
			context,
			shouldUpdateLastComment,
		)
	} else if (shouldUpdateLastComment) {
		commentToUpdate = (
			await getExistingComments(githubClient, options, context)
		).shift()
	}

	if (context.eventName === "pull_request" && commentToUpdate) {
		await githubClient.issues.updateComment({
			repo: context.repo.repo,
			owner: context.repo.owner,
			comment_id: commentToUpdate.id,
			body: body,
		})
	} else if (context.eventName === "pull_request") {
		await githubClient.issues.createComment({
			repo: context.repo.repo,
			owner: context.repo.owner,
			issue_number: context.payload.pull_request.number,
			body: body,
		})
	} else if (context.eventName === "push") {
		await githubClient.repos.createCommitComment({
			repo: context.repo.repo,
			owner: context.repo.owner,
			commit_sha: options.commit,
			body: body,
		})
	}
}

main().catch(function (err) {
	console.log(err)
	core.setFailed(err.message)
})
