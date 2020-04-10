/*
 * This file is part of Search NEU and licensed under AGPL3.
 * See the license file in the root folder for details.
 */

import moment from 'moment';
import cheerio from 'cheerio';

import cache from '../../cache';
import macros from '../../../macros';
import Request from '../../request';


import EllucianBaseParser from './ellucianBaseParser';
import ellucianSubjectParser from './ellucianSubjectParser';
import { getBaseHost } from '../../employees/util';


const request = new Request('EllucianTermsParser');

class EllucianTermsParser extends EllucianBaseParser.EllucianBaseParser {
  supportsPage(url) {
    return url.includes('bwckschd.p_disp_dyn_sched');
  }


  //
  async main(url) {
    // Possibly load from DEV
    if (macros.DEV && require.main !== module) {
      const devData = await cache.get(macros.DEV_DATA_DIR, this.constructor.name, url);
      if (devData) {
        return devData;
      }
    }

    const resp = await request.get(url);

    const termsAndPostUrl = this.parse(resp.body, url);

    const postUrl = termsAndPostUrl.postUrl;
    let terms = termsAndPostUrl.terms;

    terms = await this.addSubjects(terms, postUrl);


    // Possibly save to dev
    if (macros.DEV && require.main !== module) {
      await cache.set(macros.DEV_DATA_DIR, this.constructor.name, url, terms);

      // Don't log anything because there would just be too much logging.
    }

    return terms;
  }


  minYear() {
    return moment().year();
  }

  isValidTerm(termId, text) {
    const year = text.match(/\d{4}/);
    const minYear = this.minYear();

    if (!year) {
      macros.log('warning: could not find year for ', text);

      //if the termId starts with the >= current year, then go
      const idYear = parseInt(termId.slice(0, 4), 10);

      //if first 4 numbers of id are within 3 years of the year that it was 4 months ago
      if (idYear + 3 > minYear && idYear - 3 < minYear) {
        return true;
      }

      return false;
    }

    //skip past years
    if (parseInt(year, 10) < minYear) {
      return false;
    }
    return true;
  }


  parse(body, url) {
    const formData = this.parseTermsPage(body, url);
    const terms = [];

    formData.requestsData.forEach((singleRequestPayload) => {
      //record all the terms and their id's
      singleRequestPayload.forEach((payloadVar) => {
        if (this.shouldParseEntry(payloadVar)) {
          terms.push({
            termId: payloadVar.value,
            text: payloadVar.text,
          });
        }
      });
    });

    if (terms.length === 0) {
      macros.log('ERROR, found 0 terms??', url);
    }

    const host = getBaseHost(url);

    for (const term of terms) {
      // If this is a term that matches a term in staticHosts
      // Remove

      term.host = host;

      if (term.host === 'neu.edu') {
        if (term.text.toLowerCase().includes(' law ')) {
          term.subCollegeName = 'LAW';
          term.text = term.text.replace(/LAW/gi, '');
        } else if (term.text.toLowerCase().includes(' cps ')) {
          term.subCollegeName = 'CPS';
          term.text = term.text.replace(/CPS/gi, '');
        } else {
          term.text = term.text.replace(/Semester/gi, '');
        }

        term.text = term.text.replace(/\s+/gi, ' ').trim();
      }
    }

    const outputTerms = [];

    // Keep just some of the properties and normalize the data structure to the labeled format.
    for (const term of terms) {
      outputTerms.push({
        type: 'terms',
        value: term,
        deps: null,
      });
    }

    return {
      terms: outputTerms,
      postUrl: formData.postURL,
    };
  }


  shouldParseEntry(entry) {
    if (entry.name === 'p_term') {
      return true;
    }

    return false;
  }


  async addSubjects(terms, postURL) {
    const promises = [];

    terms.forEach((term) => {
      macros.log('Parsing term: ', JSON.stringify(term.value));

      const promise = ellucianSubjectParser.main(postURL, term.value.termId).then((subjects) => {
        term.deps = subjects;
      });

      promises.push(promise);
    });


    // Wait for all the subjects to be parsed.
    await Promise.all(promises);

    return terms;
  }


  //step 1, select the terms
  //starting url is the terms page
  parseTermsPage(body, url) {
    // Parse the dom
    const $ = cheerio.load(body);

    const parsedForm = this.parseForm(url, $('body')[0]);

    if (!parsedForm) {
      macros.error('default form data failed');
      return null;
    }

    const defaultFormData = parsedForm.payloads;


    //find the term entry and all the other entries
    let termEntry;
    const otherEntries = [];
    defaultFormData.forEach((entry) => {
      if (this.shouldParseEntry(entry)) {
        if (termEntry) {
          macros.error('Already and entry???', termEntry);
        }
        termEntry = entry;
      } else {
        otherEntries.push(entry);
      }
    });

    if (!termEntry) {
      macros.error('Could not find an entry!', url, JSON.stringify(parsedForm));
      return null;
    }

    const requestsData = [];

    //setup an indidual request for each valid entry on the form - includes the term entry and all other other entries
    termEntry.alts.forEach((entry) => {
      if (!this.shouldParseEntry(entry)) {
        macros.log('ERROR: entry was alt of term entry but not same name?', entry);
        return;
      }
      entry.text = entry.text.trim();

      if (entry.text.toLowerCase() === 'none') {
        return;
      }
      entry.text = entry.text.replace(/\(view only\)/gi, '').trim();

      entry.text = entry.text.replace(/summer i$/gi, 'Summer 1').replace(/summer ii$/gi, 'Summer 2');

      //dont process this element on error
      if (entry.text.length < 2) {
        macros.log('warning: empty entry.text on form?', entry, url);
        return;
      }

      if (!this.isValidTerm(entry.value, entry.text)) {
        return;
      }


      const fullRequestData = otherEntries.slice(0);

      fullRequestData.push({
        name: entry.name,
        value: entry.value,
        text: entry.text,
      });

      requestsData.push(fullRequestData);
    });

    return {
      postURL: parsedForm.postURL,
      requestsData: requestsData,
    };
  }

  async test() {
    const output = await this.main('https://wl11gp.neu.edu/udcprod8/bwckschd.p_disp_dyn_sched');
    for (const thing of output) {
      delete thing.deps;
    }
    macros.log(output);
  }
}


EllucianTermsParser.prototype.EllucianTermsParser = EllucianTermsParser;
const instance = new EllucianTermsParser();


if (require.main === module) {
  instance.test();
}

export default instance;
