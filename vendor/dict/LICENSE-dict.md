# vocab.json: sources, licenses and attribution

`vocab.json` is a derived data file. It contains Japanese glosses for English words, a list of "easy" words, CEFR levels and a map of irregular forms. It was built on 2026-10-19 from the sources below.

`basic.json` (used by 語をタップで意味, app/wordtap.js) holds up to three short Japanese senses for each word of the "easy" list in `vocab.json`, shortened from EJDict-hand v2.0.1 (section 1) in the same way. Because its word list comes from `vocab.json`, it is distributed under the same license (CC BY-SA 4.0).

**License of `vocab.json`: Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)**
(https://creativecommons.org/licenses/by-sa/4.0/). The ShareAlike terms are inherited from the Octanove Vocabulary Profile and from wordfreq, both of which were used to select entries. They apply to this data file and to any data derived from it. They do not apply to the application code that loads the file.

## Required attribution text

Show this text, or an equivalent, wherever the app credits its third-party data (for example an "About / Credits" screen):

> English–Japanese glosses from **EJDict-hand** by kujirahand (public domain, CC0) — https://github.com/kujirahand/EJDict
> Word levels from **The CEFR-J Wordlist Version 1.5**, compiled by Yukio Tono, Tokyo University of Foreign Studies (© Tono Laboratory, TUFS) — http://www.cefr-j.org/download.html, via https://github.com/openlanguageprofiles/olp-en-cefrj
> and the **Octanove Vocabulary Profile C1/C2 1.0** by Octanove Labs (CC BY-SA 4.0) — https://github.com/openlanguageprofiles/olp-en-cefrj
> Word-frequency ranks from **wordfreq** by Robyn Speer (data CC BY-SA 4.0), which includes data from Google Books Ngrams (http://books.google.com/ngrams), the Leeds Internet Corpus, Wikipedia, ParaCrawl, OPUS OpenSubtitles 2018 (http://www.opensubtitles.org/), and SUBTLEX (Brysbaert et al.; freely available data) — https://github.com/rspeer/wordfreq
> The combined data file is distributed under CC BY-SA 4.0. Glosses were shortened and partly hand-edited.

## Sources in detail

### 1. EJDict-hand (English→Japanese glosses)
- Repository: https://github.com/kujirahand/EJDict (README, `LICENSE` = CC0 1.0 Universal text)
- File used: release **v2.0.1** `ejdic-hand-txt.zip` → `ejdict-hand-utf8.txt`
  (https://github.com/kujirahand/EJDict/releases/download/v2.0.1/ejdic-hand-txt.zip, sha256 `af19b3f0…cd7615d`)
- License: **Public Domain / CC0 1.0**. The README says: "This is the English-Japanese Dictionary data (Public Domain / No Copyright)". Attribution is not required, but it is given above as a courtesy.
- Use: every gloss starts from the EJDict entry. The build removes the markup 《…》, 〈…〉, {…}, (…), 〔…〕, [..], 『』, =cross-refs and +construction notes. It keeps the first sense that EJDict marks as primary with 『』, or otherwise the first non-archaic sense. That sense is cut to its first one or two comma-separated items (at most 20 characters, 6.5 on average).

### 2. CEFR-J Wordlist Version 1.5 (A1–B2)
- Source: https://github.com/openlanguageprofiles/olp-en-cefrj/blob/master/cefrj-vocabulary-profile-1.5.csv
  (repo commit `d4e45b7`, sha256 `b0dd3c63…98e10ae498`). The original distribution is http://www.cefr-j.org/download.html
- Terms of use, quoted from the repository README: "CEFR-J vocabulary and grammar profile datasets can be used for research and commercial purposes with no charge, provided that you cite the dataset properly. The copyright belongs to Tono Laboratory at TUFS (Tokyo University of Foreign Studies). Neither CEFR-J nor Open Language Profiles is responsible or liable for any inaccuracies in the dataset or any damage resulting from using the dataset."
- Required citation: *The CEFR-J Wordlist Version 1.5. Compiled by Yukio Tono, Tokyo University of Foreign Studies. Retrieved from http://www.cefr-j.org/download.html (via openlanguageprofiles/olp-en-cefrj, 2026-10-19).*
- Use: A1–B1 headwords form the core of `easy`. B2 headwords go into `lv` with the value "B2", unless frequency makes them easy (see below).

### 3. Octanove Vocabulary Profile C1/C2 (ver 1.0)
- Source: https://github.com/openlanguageprofiles/olp-en-cefrj/blob/master/octanove-vocabulary-profile-c1c2-1.0.csv (sha256 `18c33a40…e0f7b380`)
- License: **CC BY-SA 4.0** (stated in the repository README). Author: Octanove Labs (http://www.octanove.com/).
- Use: supplies the C1/C2 values in `lv`. C1/C2 words never become "easy" through the derivation rules.

### 4. wordfreq (frequency ranks only)
- Source: https://github.com/rspeer/wordfreq, file `wordfreq/data/small_en.msgpack.gz` (master commit `912caf6`, release line v3.0.x, sha256 `f94a80cb…f61298247`)
- License: the code is Apache-2.0. The data is **CC BY-SA 4.0**. It includes Google Books Ngrams data (acknowledgement requested), CC-licensed Leeds Internet Corpus / Wikipedia / ParaCrawl data, OPUS OpenSubtitles 2018 data (attribution to OpenSubtitles), SUBTLEX lists (credit the SUBTLEX authors, Marc Brysbaert et al.; SUBTLEX is freely available data) and Twitter-derived statistics. See the wordfreq README, section "License".
- Use: **no frequencies are redistributed.** Lemma ranks were used only as a yes/no threshold when building `easy`:
  - a CEFR-J B2 word is easy if its rank is ≤ 2,500;
  - a word with no CEFR level is easy if its rank is ≤ 5,000;
  - an Octanove C1/C2 word is easy if its rank is ≤ 2,000.

### 5. Hand-made material (this project)
These files were written for this project and are released under the same CC BY-SA 4.0 terms:
- An extra easy list of function words, numbers, days and common loanwords.
- About 300 gloss overrides. These fix EJDict typos such as 「共同会社」, 「関連のた」 and 「影響を及ばす」, and replace archaic or wrong-for-context first senses (hierarchy → 階層、序列; peer → 仲間、同輩; pose → （問題を）引き起こす).
- A list of about 320 hand-written irregular forms. These are merged with EJDict pointer entries such as "goの過去" and "phenomenonの複数形", giving 484 entries in `irregular`.

## Other build rules
- Proper nouns are excluded: only all-lowercase EJDict headwords become glosses.
- A word is added to `easy` when its gloss is (or starts with) a plain katakana loanword, e.g. サバンナ or カメレオン.
- Transparent derivations of easy words count as easy. Examples are -ly, -ness, -less, -ful, -ment, -ity, -ation, -ion, -ance, -ism, -ist, -al, -ic, -ive, -able, -en, agentive -er/-or, the prefixes un-/in-/dis-/re-/over-/under-/mis-/self-/pre-, and hyphenated compounds of easy words. Apart from -ly/-ness/-less/-ful, a derivation counts only when its EJDict gloss shares a content kanji with its base word's entry. A negative prefix also needs a negative gloss (不/非/無/ない).
