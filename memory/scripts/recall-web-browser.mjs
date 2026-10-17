/** Real-server browser recording using repository Playwright when CUA exposes no browser. */
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { readFile, writeFile, appendFile, readdir } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const memory = fileURLToPath(new URL('../', import.meta.url))
const server = JSON.parse(await readFile(join(memory, '.artifacts/workspace-web-current.json'), 'utf8'))
if (!server.url || server.keyless || !resolve(server.run).startsWith(resolve(memory, '.artifacts') + sep)) throw new Error('A ready --real memory Web run is required')
const require = createRequire(join(memory, '../apps/web/package.json'))
const { chromium } = require('playwright')
const { expect } = require('playwright/test')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const size = { width: 1440, height: 1000 }
const recordVideo = process.argv.includes('--video')
const context = await browser.newContext({ viewport: size, ...recordVideo ? { recordVideo: { dir: join(server.run, 'videos'), size } } : {} })
const page = await context.newPage()
const video = page.video()
const input = createInterface({ input: process.stdin, terminal: false })
let frame = (await readdir(join(server.run, 'frames'))).filter(name => /^\d+\.png$/u.test(name)).length
const snapshot = async () => {
  const text = await page.locator('body').innerText()
  await writeFile(join(server.run, 'real-dom.txt'), text)
  console.log(text)
}
try {
  await page.goto(server.url)
  await page.getByRole('button', { name: '新建会话', exact: true }).first().waitFor({ timeout: 60000 })
  console.log('REAL_BROWSER_READY')
  await snapshot()
  for await (const line of input) {
    const command = JSON.parse(line)
    await appendFile(join(server.run, 'real-browser-actions.jsonl'), `${JSON.stringify({ time: Date.now(), command })}\n`)
    const target = command.role ? page.getByRole(command.role, { name: command.name, exact: command.exact ?? true })
      : command.label ? page.getByLabel(command.label, { exact: true }) : command.text ? page.getByText(command.text, { exact: command.exact ?? true }) : page.locator(command.selector ?? 'body')
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
    }
    else if (command.op === 'click') await locator.click()
    else if (command.op === 'fill') await locator.fill(command.value)
    else if (command.op === 'check') await locator.check()
    else if (command.op === 'uncheck') await locator.uncheck()
    else if (command.op === 'press') await locator.press(command.key)
    else if (command.op === 'wait') await locator.waitFor({ timeout: command.timeout ?? 60000 })
    else if (command.op === 'waitHidden') await locator.waitFor({ state: 'hidden', timeout: command.timeout ?? 60000 })
    else if (command.op === 'capture') {
      const file = command.file ?? `${String(frame++).padStart(2, '0')}.png`
      if (basename(file) !== file || !file.endsWith('.png')) throw new Error('Screenshot filename must be a PNG basename')
      await page.screenshot({ path: join(server.run, 'frames', file) })
    }
    else if (command.op === 'assertChecked') {
      await expect(locator).toBeEnabled({ timeout: 10000 })
      await expect(locator).toHaveAttribute('aria-checked', String(command.checked), { timeout: 10000 })
      const checked = await locator.getAttribute('aria-checked')
      await appendFile(join(server.run, 'ui-assertions.jsonl'), `${JSON.stringify({ time: Date.now(), name: command.name, checked })}\n`)
    }
    else if (command.op === 'refresh') await page.reload()
    else if (command.op === 'controls') console.log(JSON.stringify(await page.locator('button,input,[role="switch"],[contenteditable="true"],summary').evaluateAll(elements => elements.map(element => ({
      tag: element.tagName, role: element.getAttribute('role'), name: element.getAttribute('aria-label'), text: element.textContent,
      type: element.getAttribute('type'), checked: element.getAttribute('aria-checked'), placeholder: element.getAttribute('placeholder'), disabled: element.hasAttribute('disabled') }))), null, 2))
    else if (command.op === 'close') break
    else if (command.op !== 'snapshot') throw new Error('Unsupported real browser action')
    await snapshot()
  }
} catch (error) {
  await page.screenshot({ path: join(server.run, 'browser-failure.png') }).catch(() => {})
  console.error(String(error.message).replace(/https?:\/\/[^\s]+/gu, '[local Web server]'))
  process.exitCode = 1
} finally {
  input.close()
  process.stdin.pause()
  await context.close()
  if (video !== null) await video.saveAs(join(server.run, 'demo.webm'))
  await browser.close()
}
