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

let urlValue
let outputDir
let isPro = false
const prompt = inquirer.createPromptModule()
const progress = new PleasantProgress()
const rp = requestPromise.defaults({ jar: true })
const SIGN_IN_URL = 'https://egghead.io/users/sign_in'

program
  .version(pkg.version)
  .arguments('<url> [output-dir]')
  .option('-e, --email <email>', 'Account email (only required for Pro accounts)')
  .option('-p, --password [password]', 'Account password (only required for Pro accounts)', true)
  .option('-c, --count', 'Add the number of the video to the filename (only for playlists and series)')
  .option('-f, --force', 'Overwriting existing files')
  .action((url, output) => {
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

function fileExists(p) {
  try {
    return fs.statSync(p).isFile()
  } catch (e) {
    return false
  }
}

async function getCSRFToken() {
  const body = await rp(SIGN_IN_URL)
  const pattern = /<meta name="csrf-token" content="(.*)" \/>/
  const [, CSRFToken] = pattern.exec(body) || []
  return CSRFToken
}

async function authenticate(email, password) {
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

async function doTheMagic() {
  if (program.email) {
    if (program.password === true) {
      const { password } = await prompt({
        type: 'password',
        name: 'password',
        message: 'Egghead.io password'
      })
      program.password = password
    }
    try {
      await authenticate(program.email, program.password)
      isPro = true
      success('Authenticated!')
    } catch (err) {
      return error(err)
    }
  }

  const videos = await getVideoData()
  if (!videos.length) {
    error('no video found!')
  }
  success(`Found ${videos.length} ${(videos.length) > 1 ? 'videos' : 'video'}`)

  createOutputDirectoryIfNeeded()

  const padLength = String(videos.length).length
  const padZeros = '0'.repeat(padLength)
  let i = 0
  for (const { url, filename, transcript, code } of videos) {
    i++
    let paddedCounter = `${padZeros}${i}`.slice(-padLength)
    let subDir = path.join(outputDir, paddedCounter)
    createSubDirectoryIfNeeded(subDir)
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
async function getVideoData() {
  try {
    const [, lessonSlug] = /egghead.io\/lessons\/([^\?]*)/.exec(urlValue) || []
    let source = await rp(urlValue)

    if (lessonSlug) {
      let videoData
      success('The URL is a lesson')

      if (isPro) {
        const response = await rp({
          uri: `https://egghead.io/api/v1/lessons/${lessonSlug}/next_up`,
          json: true
        })
        const { lessons } = response.list || { lessons: [] }

        videoData = lessons
          .filter((lesson) => lesson.slug === lessonSlug)
          .map((lesson) => {
            const pattern = /https:\/\/.*\/lessons\/.*\/(.*)\?.*/
            const [url, filename] = pattern.exec(lesson.download_url)
            return { url, filename }
          })[0]
      } else {
        videoData = await parseLessonPage(source)
      }

      // process the lesson page
      if (videoData) {
        return [videoData]
      } else {
        error(`failed to parse the lesson page '${urlValue}'}`)
      }
    } else {
      let lessonURLs = []
      success('The URL is a playlist or series')

      // get the urls of the lessions
      const re = /<h4 class="title"><a href="(https:\/\/egghead.io\/lessons\/.+?)">/g
      // regexp in js have no matchAll method or something similiar..
      let match
      while ((match = re.exec(source))) {
        lessonURLs.push(match[1])
      }
      success(`Found ${lessonURLs.length} ${(lessonURLs.length) > 1 ? 'lessons' : 'lesson'}`)
      // if (isPro) {
      //   const firstLesson = lessonURLs[0]
      //   const pattern = /egghead.io\/lessons\/(.*)\?/
      //   const [, lessonSlug] = pattern.exec(firstLesson) || []
      //   const response = await rp({
      //     uri: `https://egghead.io/api/v1/lessons/${lessonSlug}/next_up`,
      //     json: true
      //   })
      //   const { lessons } = response.list || { lessons: [] }

      //   return lessons.map((lesson) => {
      //     const pattern = /https:\/\/.*\/lessons\/.*\/(.*)\?.*/
      //     const [url, filename] = pattern.exec(lesson.download_url)
      //     return { url, filename }
      //   })
      // }
      progress.start('Fetching lesson pages')
      // fetch and process the lessons, start all requests at the same time to save time.
      const promises = lessonURLs.map(processLessonURL)
      const result = await Promise.all(promises.map(reflect))
      progress.stop(true)
      // get the urls that succeded and thos that failed
      const videoURLs = result.filter(v => (v.state === 'resolved')).map(v => v.value)
      const failed = result.filter(v => (v.state === 'rejected'))
      // check if we have some lesson pages that failed (wrong url or paid)
      if (failed.length) {
        error(`Failed to parse the following lesson pages: ${failed.map(v => `'${v.value}'`).join(',')}. They might be for pro subscribers only`, false)
      }
      return videoURLs
    }
  } catch (e) {
    error(`fetching the url '${urlValue}' failed!`)
  }
}

// fetches the lesson page and calls parseLessonPage on it
function processLessonURL(url) {
  return new Promise((resolve, reject) => {
    rp(url).then(async (source) => {
      const videoData = await parseLessonPage(source)
      if (videoData) {
        resolve(videoData)
      } else {
        reject(url)
      }
    }, () => {
      reject(url)
    })
  })
}

//from: 
//http://stackoverflow.com/questions/10574520/extract-json-from-text
function extractJSON(str) {
  var firstOpen, firstClose, candidate;
  firstOpen = str.indexOf('{', firstOpen + 1);
  do {
    firstClose = str.lastIndexOf('}');
    // console.log('firstOpen: ' + firstOpen, 'firstClose: ' + firstClose);
    if (firstClose <= firstOpen) {
      return null;
    }
    do {
      candidate = str.substring(firstOpen, firstClose + 1);
      // console.log('candidate: ' + candidate);
      try {
        var res = JSON.parse(candidate);
        // console.log('...found');
        return [res, firstOpen, firstClose + 1];
      }
      catch (e) {
        // console.log('...failed');
      }
      firstClose = str.substr(0, firstClose).lastIndexOf('}');
    } while (firstClose > firstOpen);
    firstOpen = str.indexOf('{', firstOpen + 1);
  } while (firstOpen != -1);
}

// parses the lesson page, returns the video data if found.
async function parseLessonPage(source) {
  const reFile = /<meta itemprop="name" content="([^"]+?)".+?<meta itemprop="contentURL" content="http[^"]+?.wistia.com\/deliveries\/(.+?)\.bin"/
  const result = reFile.exec(source)
  var fileName = ""
  if (result) {
    // return {
    //   filename: result[1],
    //   url: `https://embed-ssl.wistia.com/deliveries/${result[2]}/file.mp4`
    // }
    fileName = result[1]
  }

  //get transcript
  var transcript = []
  let $ = cheerio.load(source, {
    xmlMode: true,
    decodeEntities: true
  })
  $("#tab-transcript > div > p").each(function (i, elem) {
    transcript[i] = $(this).text()
  })

  //get code link & hints
  var code = []
  code.push($("#tab-code strong > a").attr('href'))
  if ($("#tab-code em").length > 0) {
    $("#tab-code em").each(function (i, elem) {
      code.push($(this).text())
    })
  }

  const re = /<script charset="ISO-8859-1" src="(\/\/fast\.wistia\.com\/embed\/medias\/[a-z0-9]{10}\/metadata\.js)"><\/script>/
  const reVideo = /http[^"]+?.wistia.com\/deliveries\/(.+?)\.bin/
  const metaJs = await rp("http:" + re.exec(source)[1])
  var mediaJson = extractJSON(metaJs.slice(metaJs.indexOf('mediaJson'), metaJs.lastIndexOf('mediaJson')))[0]
  var videoId = "";
  //try to find 'Original file'
  for (let asset of mediaJson['assets']) {
    if (asset['type'] == 'original' && asset['slug'] == 'original') {
      videoId = reVideo.exec(asset['url'])[1]
    }
  }
  if (videoId == "") {
    console.log("No Original file with: " + fileName)
  }
  else {
    return {
      filename: fileName,
      url: `https://embed-ssl.wistia.com/deliveries/${videoId}/file.mp4`,
      transcript: transcript.join('\n'),
      code: code.join('\n')
    }
  }
}

// creates a directory
function createOutputDirectoryIfNeeded() {
  try {
    const stats = fs.lstatSync(outputDir)
    if (!stats.isDirectory()) {
      error(`Can't create the output directory '${outputDir}' because a file with the same name exists`)
    }
  } catch (e) {
    try {
      fs.mkdirSync(outputDir)
    } catch (err) {
      error(`Creating the output directory '${outputDir}' failed with error '${err}'`)
    }
  }
}

function createSubDirectoryIfNeeded(subDir) {
  try {
    const stats = fs.lstatSync(subDir)
    if (!stats.isDirectory()) {
      error(`Can't create the output directory '${subDir}' because a file with the same name exists`)
    }
  } catch (e) {
    try {
      fs.mkdirSync(subDir)
    } catch (err) {
      error(`Creating the output directory '${subDir}' failed with error '${err}'`)
    }
  }
}

// helper functions
function success(message) {
  console.log(chalk.green(message))
}

function error(message, exit = true) {
  console.log(chalk.red(`Error: ${message}`))
  if (exit) {
    process.exit(1)
  }
}

// wraps a promise in another promise that resolves when the promise either resolves or rejects
function reflect(promise) {
  return promise.then(x => ({ state: 'resolved', value: x }),
    e => ({ state: 'rejected', value: e }))
}
