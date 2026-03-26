function getKey(d) {
  return `${d.place}_${d.court}_${d.date}_${d.time}`
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function clickByText(page, text) {
  await page.getByText(text, { exact: false }).first().click()
}

module.exports = {
  getKey,
  sleep,
  clickByText
}
