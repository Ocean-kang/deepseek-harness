/** Isolated synthetic or real-provider Web acceptance with the repository's Playwright. */
import { createRequire } from 'node:module'
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import assert from 'node:assert/strict'

const memory = fileURLToPath(new URL('../', import.meta.url))
const repo = resolve(memory, '..')
const require = createRequire(join(repo, 'apps/web/package.json'))
const { chromium } = require('playwright')
const { expect } = require('playwright/test')
const stateOption = process.argv.indexOf('--state')
const statePath = stateOption < 0 ? join(memory, '.artifacts/workspace-web-current.json') : resolve(process.argv[stateOption + 1])
if (!statePath.startsWith(resolve(memory) + sep)) throw new Error('Acceptance state must remain inside memory/')
const server = JSON.parse(await readFile(statePath, 'utf8'))
if (!server.url) throw new Error('Supported Web profile is not ready')
if (!resolve(server.run).startsWith(resolve(memory, '.artifacts') + sep)) throw new Error('Acceptance run must remain inside memory/.artifacts/')
const real = !server.keyless
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const size = { width: 1440, height: 1000 }
const context = await browser.newContext({ viewport: size,
  ...process.argv.includes('--video') ? { recordVideo: { dir: join(server.run, 'videos'), size } } : {} })
const page = await context.newPage()
const video = page.video()
const frames = join(server.run, 'frames')
let sequence = (await readdir(frames)).filter(name => (real ? /^\d+\.png$/u : /^fallback-\d+\.png$/u).test(name)).length
const evidence = join(server.run, real ? 'real-browser-actions.jsonl' : 'fallback-operations.jsonl')
let input
const snapshot = async () => {
  const text = await page.locator('body').innerText()
  await writeFile(join(server.run, real ? 'real-dom.txt' : 'fallback-dom.txt'), text)
  if (!real) await appendFile(evidence, `${JSON.stringify({ kind: 'snapshot', time: Date.now(), text })}\n`)
  console.log(text)
}
const showSources = async () => {
  const detail = page.locator('details').filter({ has: page.locator('summary').getByText('来源', { exact: true }) })
  if (await detail.getAttribute('open') === null) await detail.locator('summary').click()
}
try {
  await page.goto(server.url)
  await page.getByRole('button', { name: '新建会话', exact: true }).first().waitFor({ timeout: 60000 })
  console.log(real ? 'REAL_BROWSER_READY' : 'HEADLESS_FALLBACK_READY')
  await snapshot()
  if (process.argv.includes('--verify-restart')) {
    await page.getByText('Independent memory package test response.', { exact: true }).first().click()
    await page.getByRole('button', { name: '打开右侧边栏', exact: true }).click()
    await page.getByRole('button', { name: '记忆 浏览 L0–L3，选择下一轮使用的记忆', exact: true }).click()
    await page.getByText('导入与存储维护', { exact: true }).click()
    await page.getByText('导入完成', { exact: true }).waitFor()
    await page.getByText('已清理 1 个对话', { exact: true }).waitFor()
    await page.getByLabel('开始日期', { exact: true }).fill('2026-10-01')
    await page.getByLabel('结束日期', { exact: true }).fill('2026-10-13')
    await page.getByRole('button', { name: '预览历史对话', exact: true }).click()
    await page.getByText('当前已加载预览：可导入 1 个 · 已导入 1 个 · 无法处理 0 个', { exact: true }).waitFor()
    await page.getByRole('button', { name: '加载更多', exact: true }).click()
    await page.getByText('当前已加载预览：可导入 1 个 · 已导入 3 个 · 无法处理 0 个', { exact: true }).waitFor()
    await page.getByText('导入完成', { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(frames, 'restart-import-preview.png') })
    await page.getByRole('checkbox', { name: /memory-retention-unreferenced-ebacee2e-88a3-401d-9412-89377a3ecb89/u }).check()
    await page.getByRole('button', { name: '导入所选', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('input[type="checkbox"]:checked')
      && [...document.querySelectorAll('button')].some(button => button.textContent === '预览历史对话' && !button.disabled)
      && [...document.querySelectorAll('p')].some(paragraph => paragraph.textContent === '导入完成'))
    await page.getByText('memory-retention-unreferenced-ebacee2e-88a3-401d-9412-89377a3ecb89 · 已提交 1/1 条事件', { exact: true }).waitFor()
    await page.getByText('导入完成', { exact: true }).waitFor()
    await page.getByLabel('保留天数', { exact: true }).fill('1')
    await page.getByRole('button', { name: '预览清理', exact: true }).click()
    await page.getByText(/可清理 1 个对话 · 保护 1 个对话/u).waitFor()
    await page.getByRole('button', { name: '执行清理', exact: true }).click()
    await page.getByText('已清理 1 个对话', { exact: true }).waitFor()
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].some(button => button.textContent === '执行清理'))
    await page.getByText('已清理 1 个对话', { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(frames, 'final-package-cleanup-executed.png') })
    await page.getByRole('button', { name: '预览清理', exact: true }).click()
    await page.getByText(/可清理 0 个对话 · 保护 1 个对话/u).waitFor()
    await page.getByRole('button', { name: '压缩数据库文件', exact: true }).click()
    await page.getByText('数据库压缩已完成', { exact: true }).waitFor()
    await snapshot()
    await page.getByText('导入与存储维护', { exact: true }).click()
    await page.getByRole('button', { name: 'L3: 稳定知识与偏好', exact: true }).click()
    await page.getByRole('button', { name: '查看正文与来源: [安装验收样例] Portable ESM', exact: true }).click()
    await showSources()
    await page.getByRole('button', { name: '028b6c39-3f91-454e-8ee9-0468a7e52b93 · v3', exact: true }).click()
    await page.getByText('L2 · v3 · 有效', { exact: true }).waitFor()
    await showSources()
    await page.getByRole('button', { name: 'cd6e2db2eb8fe321b224c2b2575ce6d584f40ea9e9ef777cdd1556d51611c24f · v1', exact: true }).click()
    await page.getByRole('heading', { name: '[安装验收样例] Portable ESM constraint', exact: true }).waitFor()
    await showSources()
    await page.getByText('memory-retention-supported-1a36f67b-9d2f-4779-8865-945a33aee30a #1', { exact: true }).waitFor()
    await page.getByText('执行详情', { exact: true }).click()
    const trace = page.locator('details').filter({ has: page.locator('summary').getByText('执行详情', { exact: true }) })
    await trace.locator('pre').waitFor()
    const parts = []
    for (;;) {
      const text = await trace.locator('pre').innerText()
      assert.ok(Buffer.byteLength(text) <= 16)
      parts.push(text)
      const next = trace.getByRole('button', { name: '加载更多', exact: true })
      if (await next.count() === 0) break
      await next.click()
      await page.waitForFunction(({ previous }) => {
        const panel = [...document.querySelectorAll('details')].find(detail => detail.querySelector('summary')?.textContent === '执行详情')
        return panel?.querySelector('pre')?.textContent !== previous
      }, { previous: text })
    }
    assert.deepEqual(JSON.parse(parts.join('')), { actions: [], commands: [], files: [], errors: [] })
    await page.screenshot({ path: join(frames, 'restart-protected-source-trace.png') })
    await snapshot()
    await writeFile(join(server.run, 'web-restart-proof.json'), JSON.stringify({ synthetic: true,
      archiveSha256: server.archiveSha256, browserFallback: 'repository Playwright; fresh headless Chrome context; CUA unavailable',
      browserPageSize: server.browserPageSize, tracePageMaxBytes: server.tracePageMaxBytes, importStatusRecovered: true,
      cleanupStatusRecovered: true, previewPages: 2, available: 1, imported: 3, cleanedSourceNotRecaptured: true,
      compactionComplete: true,
      explicitReimportRestoredCleanedSource: true, cleanupExecutedFinalBundle: true,
      protectedSource: 'memory-retention-supported-1a36f67b-9d2f-4779-8865-945a33aee30a',
      activeL3Revision: 3, tracePages: parts.length, trace: JSON.parse(parts.join('')) }, null, 2))
    console.log('WEB_RESTART_ACCEPTANCE_PASSED')
  } else {
  input = createInterface({ input: process.stdin, terminal: false })
  for await (const line of input) {
    try {
      const command = JSON.parse(line)
      await appendFile(evidence, `${JSON.stringify({ ...real ? {} : { kind: 'action' }, time: Date.now(), command })}\n`)
      const target = command.role ? page.getByRole(command.role, { name: command.name, exact: command.exact ?? true })
        : command.label ? page.getByLabel(command.label, { exact: true })
          : command.text ? page.getByText(command.text, { exact: command.exact ?? true }) : page.locator(command.selector ?? 'body')
      const locator = command.index === undefined ? target : target.nth(command.index)
      if (command.op === 'expandTool') {
        if (!await locator.isVisible()) {
          const group = page.getByRole('button', { name: '已调用工具', exact: true })
          if (!await group.isVisible()) await page.getByRole('button', { name: /^已完成，用时/u }).click()
          await group.waitFor({ state: 'visible' })
          await group.click()
        }
        await locator.waitFor({ state: 'visible' })
        if (await locator.locator('..').getAttribute('open') === null) await locator.click()
      } else if (command.op === 'click') await locator.click()
      else if (command.op === 'fill') await locator.fill(command.value)
      else if (command.op === 'check') await locator.check()
      else if (command.op === 'uncheck') await locator.uncheck()
      else if (command.op === 'press') await locator.press(command.key)
      else if (command.op === 'wait') await locator.waitFor({ state: 'visible', timeout: command.timeout ?? 60000 })
      else if (command.op === 'waitHidden') await locator.waitFor({ state: 'hidden', timeout: command.timeout ?? 60000 })
      else if (command.op === 'capture') {
        const name = command.file ?? `${real ? '' : 'fallback-'}${String(sequence++).padStart(2, '0')}.png`
        if (basename(name) !== name || !name.endsWith('.png')) throw new Error('Screenshot filename must be a PNG basename')
        await page.screenshot({ path: join(frames, name), fullPage: !real })
        if (!real) console.log(`SCREENSHOT ${name}`)
      } else if (command.op === 'assertChecked') {
        await expect(locator).toBeEnabled({ timeout: 10000 })
        await expect(locator).toHaveAttribute('aria-checked', String(command.checked), { timeout: 10000 })
        const checked = await locator.getAttribute('aria-checked')
        await appendFile(join(server.run, 'ui-assertions.jsonl'), `${JSON.stringify({ time: Date.now(), name: command.name, checked })}\n`)
      } else if (command.op === 'controls') {
        console.log(JSON.stringify(await page.locator('button,input,[role="checkbox"],[role="switch"],[contenteditable="true"],summary').evaluateAll(elements => elements.map(element => ({
          tag: element.tagName, role: element.getAttribute('role'), name: element.getAttribute('aria-label'),
          text: element.textContent, type: element.getAttribute('type'), value: element.getAttribute('value'),
          checked: element.getAttribute('aria-checked'), placeholder: element.getAttribute('placeholder'), disabled: element.hasAttribute('disabled') }))), null, 2))
      } else if (command.op === 'close') break
      else if (command.op === 'refresh') await page.reload()
      else if (command.op !== 'snapshot') throw new Error('Unsupported acceptance operation')
      await snapshot()
    } catch (error) {
      if (real) throw error
      const message = error.message.replace(/https?:\/\/\S+/gu, '[private URL]')
      await appendFile(evidence, `${JSON.stringify({ kind: 'failure', time: Date.now(), message })}\n`)
      console.log(`ACTION_ERROR ${message}`)
      process.exitCode = 1
      break
    }
  }
  }
} catch (error) {
  const captures = await Promise.allSettled([snapshot(), page.screenshot({ path: join(server.run, real ? 'browser-failure.png' : 'frames/fallback-failure.png') })])
  for (const captured of captures) if (captured.status === 'rejected') console.error('Failure capture unavailable:', captured.reason.message)
  if (real) {
    console.error(String(error.message).replace(/https?:\/\/\S+/gu, '[local Web server]'))
    process.exitCode = 1
  } else throw error
} finally {
  input?.close()
  process.stdin.pause()
  try {
    await context.close()
    if (video !== null) await video.saveAs(join(server.run, 'demo.webm'))
  } finally { await browser.close() }
}
