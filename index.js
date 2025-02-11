const puppeteer = require('puppeteer');
const {parseISO, compareAsc, isBefore, format} = require('date-fns')
require('dotenv').config();

const {delay, sendEmail, logStep} = require('./utils');
const {siteInfo, loginCred, IS_PROD, NEXT_SCHEDULE_POLL, MAX_NUMBER_OF_POLL, NOTIFY_ON_DATE_BEFORE} = require('./config');

let delayTime = NEXT_SCHEDULE_POLL;
let isLoggedIn = false;
let maxTries = MAX_NUMBER_OF_POLL

const login = async (page) => {
  logStep('logging in');
  await page.goto(siteInfo.LOGIN_URL);

  const form = await page.$("form#sign_in_form");

  const email = await form.$('input[name="user[email]"]');
  const password = await form.$('input[name="user[password]"]');
  const privacyTerms = await form.$('input[name="policy_confirmed"]');
  const signInButton = await form.$('input[name="commit"]');

  await email.type(loginCred.EMAIL);
  await password.type(loginCred.PASSWORD);
  await privacyTerms.click();
  await signInButton.click();

  await page.waitForNavigation();

  return true;
}

const notifyMe = async (earliestDate) => {
  const formattedDate = format(earliestDate, 'dd-MM-yyyy');
  logStep(`sending an email to schedule for ${formattedDate}`);
  await sendEmail({
    subject: `We found an earlier date ${formattedDate}(Vancouver)`,
    text: `Hurry and schedule for ${formattedDate} before it is taken.(Vancouver)`
  })
}

const checkForSchedules = async (page, FACILITY_ID) => {
  logStep('checking for schedules');
  await page.setExtraHTTPHeaders({
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'X-Requested-With': 'XMLHttpRequest'
  });

  const url = `https://ais.usvisa-info.com/${siteInfo.COUNTRY_CODE}/niv/schedule/${siteInfo.SCHEDULE_ID}/appointment/days/${FACILITY_ID}.json?appointments%5Bexpedite%5D=false`
  try{
    await page.goto(url);
  } catch(err){
    console.error(err);
  };
  

  const originalPageContent = await page.content();
  const bodyText = await page.evaluate(() => {
    return document.querySelector('body').innerText
  });

  try{
    console.log(bodyText);

    const parsedBody =  JSON.parse(bodyText);

    if(!Array.isArray(parsedBody)) {
      throw "Failed to parse dates, probably because you are not logged in";
    }

    const dates =parsedBody.map(item => parseISO(item.date));
    const [earliest] = dates.sort(compareAsc)

    await delay(3_000)
    return earliest;
  }catch(err){
    console.log("Unable to parse page JSON content", originalPageContent);
    console.error(err)
    isLoggedIn = false;
  }
}


const process = async (browser) => {
  logStep(`starting process with ${maxTries} tries left`);

  if(maxTries-- <= 0){
    console.log('Reached Max tries')
    return
  }

  const page = await browser.newPage();

  if(!isLoggedIn) {
     isLoggedIn = await login(page);
  }

  const facilityIDNumber = siteInfo.LAST_FACILITY_ID - siteInfo.FIRST_FACILITY_ID + 1; // number of facilities
  let apptNotAvailable = true
  for (let i = 0; i < facilityIDNumber; ++i) {
    const earliestDate = await checkForSchedules(page, i + parseInt(siteInfo.FIRST_FACILITY_ID));
    if (earliestDate != undefined) apptNotAvailable = false;
    if(earliestDate && isBefore(earliestDate, parseISO(NOTIFY_ON_DATE_BEFORE))){
      await notifyMe(earliestDate);
    }
  }

  //if no schedules found, delay for 2 minutes
  if(apptNotAvailable) {
    delayTime = 120_000;
  } else {
    delayTime = 30_000;
  }
  
  await page.close();

  await delay(delayTime)

  await process(browser)
}


(async () => {
  const browser = await puppeteer.launch(!IS_PROD ? {headless: false}: undefined);

  try{
    await process(browser);
  }catch(err){
    console.error(err);
  }

  await browser.close();
})();
