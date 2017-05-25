#! /usr/bin/env node
const program = require('commander')
const pkg = require('../package.json')
const chalk = require('chalk')
const requestPromise = require('request-promise')
const request = require('request')
const PleasantProgress = require('pleasant-progress')
const path = require('path')
const fs = require('fs')
const inquirer = require('inquirer')
const cheerio = require('cheerio')

let email
let urlValue
let outputDir
const prompt = inquirer.createPromptModule()
const progress = new PleasantProgress()
const rp = requestPromise.defaults({ jar: true })
const SIGN_IN_URL = 'https://egghead.io/users/sign_in'

program
  .version(pkg.version)
  .arguments('<account> <url> [output-dir]')
  .option('-p, --password [password]', 'Account password (only required for Pro accounts)', true)
  .option('-c, --count', 'Add the number of the video to the filename (only for playlists and series)')
  .option('-f, --force', 'Overwriting existing files')
  .action((account, url, output) => {
    email = account
    urlValue = url
    outputDir = output ? path.resolve(output) : process.cwd()
  })
program.parse(process.argv)

if (process.argv.slice(2).length < 2) {
  program.outputHelp()
  process.exit()
}

if (!/egghead.io\/(lessons|series|playlists|courses)\//.test(urlValue)) {
  error('unsupported url!')
}

// await is only supported in functions (with the async keyword)
doTheMagic()

function fileExists (p) {
  try {
    return fs.statSync(p).isFile()
  } catch (e) {
    return false
  }
}

async function getCSRFToken () {
  const body = await rp(SIGN_IN_URL)
  const pattern = /<meta name="csrf-token" content="(.*)" \/>/
  const [, CSRFToken] = pattern.exec(body) || []
  return CSRFToken
}

async function authenticate (email, password) {
  const CSRFToken = await getCSRFToken()
  const options = {
    method: 'POST',
    uri: SIGN_IN_URL,
    form: {
      'user[email]': email,
      'user[password]': password,
      'authenticity_token': CSRFToken
    },
    simple: false,
    resolveWithFullResponse: true
  }

  const response = await rp(options)

  if (response.statusCode !== 302) {
    throw Error('Failed to authenticate.')
  }
}

async function doTheMagic () {
  if (program.password === true) {
    const { password } = await prompt({
      type: 'password',
      name: 'password',
      message: 'Egghead.io password'
    })
    program.password = password
  }
  try {
    await authenticate(email, program.password)
    success('Authenticated!')
  } catch (err) {
    return error(err)
  }

  const videos = await getVideoData()
  if (!videos.length) {
    error('no video found!')
  }
  success(`Found ${videos.length} ${(videos.length) > 1 ? 'videos' : 'video'}`)

  createDirectoryIfNeeded(outputDir)

  const padLength = String(videos.length).length
  const padZeros = '0'.repeat(padLength)
  let i = 0
  for (const { url, filename, transcript, code } of videos) {
    i++
    let paddedCounter = `${padZeros}${i}`.slice(-padLength)
    let subDir = path.join(outputDir, paddedCounter)
    createDirectoryIfNeeded(subDir)
    const p = path.join(subDir, (program.count ? `${paddedCounter}-${filename}` : filename))
    if (!program.force && fileExists(p)) {
      console.log(`File ${paddedCounter}-${filename} already exists, skip`)
      continue
    }
    progress.start(`Downloading video ${paddedCounter} out of ${videos.length}: '${filename}'`)
    const stream = fs.createWriteStream(p)
    await new Promise((resolve, reject) => {
      request(url)
        .on('error', () => {
          error(`download of '${url}' failed!`, false)
          reject()
        })
        .on('end', () => {
          resolve()
        })
        .pipe(stream)
    })
    fs.writeFileSync(path.join(subDir, 'code'), code, {encoding: 'utf8'})
    fs.writeFileSync(path.join(subDir, 'transcript'), transcript, {encoding: 'utf8'})
    stream.close()
    progress.stop(true)
  }
  success('Done!')
}

// loads the url and parses it, when it's playlist/serie loads the video pages
// too, and returns an array with the video data
async function getVideoData () {
  try {
    const [, lessonSlug] = /egghead.io\/lessons\/([^\?]*)/.exec(urlValue) || []
    let source = await rp(urlValue)

    if (lessonSlug) {
      success('The URL is a lesson')

      const response = await rp({
        uri: `https://egghead.io/api/v1/lessons/${lessonSlug}/next_up`,
        json: true
      })
      const { lessons } = response.list || { lessons: [] }

      return Promise.all([lessons
        .filter((lesson) => lesson.slug === lessonSlug)
        .map(async (lesson) => {
          const pattern = /https:\/\/.*\/lessons\/.*\/(.*)\?.*/
          const [url, filename] = pattern.exec(lesson.download_url)
          const source = await rp(lesson.lesson_http_url)
          const html = cheerio.load(source, {
            xmlMode: true,
            decodeEntities: true
          })
          return { url, filename, transcript: parseTranscript(html), code: parseCodeURL(html) }
        })[0]])
    } else {
      let lessonURLs = []
      success('The URL is a playlist or series')

      // get the urls of the lessions
      const re = /<a href="(https:\/\/egghead.io\/lessons\/.+?)" class="base no-underline mb3/g
      // regexp in js have no matchAll method or something similiar..
      let match
      while ((match = re.exec(source))) {
        lessonURLs.push(match[1])
      }
      success(`Found ${lessonURLs.length} ${(lessonURLs.length) > 1 ? 'lessons' : 'lesson'}`)
      const firstLesson = lessonURLs[0]
      const pattern = /egghead.io\/lessons\/(.*)/
      const [, lessonSlug] = pattern.exec(firstLesson) || []
      const response = await rp({
        uri: `https://egghead.io/api/v1/lessons/${lessonSlug}/next_up`,
        json: true
      })
      const { lessons } = response.list || { lessons: [] }

      return Promise.all(lessons.map(async (lesson) => {
        const pattern = /https:\/\/.*\/lessons\/.*\/(.*)\?.*/
        const [url, filename] = pattern.exec(lesson.download_url)
        const source = await rp(lesson.lesson_http_url)
        const html = cheerio.load(source, {
          xmlMode: true,
          decodeEntities: true
        })
        return { url, filename, transcript: parseTranscript(html), code: parseCodeURL(html) }
      }))
    }
  } catch (e) {
    error(`fetching the url '${urlValue}' failed!`)
  }
}

function parseCodeURL ($) {
  let code = []
  code.push($('#tab-code strong > a').attr('href'))
  if ($('#tab-code em').length > 0) {
    $('#tab-code em').each(function (i, elem) {
      code.push($(this).text())
    })
  }

  return code.join('\n')
}

function parseTranscript ($) {
  let transcript = []
  $('#tab-transcript > div > p').each(function (i, elem) {
    transcript[i] = $(this).text()
  })

  return transcript.join('\n')
}

// creates a directory
function createDirectoryIfNeeded (dir) {
  try {
    const stats = fs.lstatSync(dir)
    if (!stats.isDirectory()) {
      error(`Can't create the directory '${dir}' because a file with the same name exists`)
    }
  } catch (e) {
    try {
      fs.mkdirSync(dir)
    } catch (err) {
      error(`Creating the directory '${dir}' failed with error '${err}'`)
    }
  }
}

// helper functions
function success (message) {
  console.log(chalk.green(message))
}

function error (message, exit = true) {
  console.log(chalk.red(`Error: ${message}`))
  if (exit) {
    process.exit(1)
  }
}
