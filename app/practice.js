// Practice sequence and the evidence notes shown in the app. Kept separate so the
// wording can be revised without touching the app logic. Repetition counts are design
// choices extrapolated from the studies below, not values any single study tested.

export const PLAN = [
  { title: '初見で黙読し、内容を確かめる', body: '区切りなしで1回黙読して時間を測り、段落ごとの要点を日本語で一言メモします。これが今日の出発点です。長文は100〜200語ほどの段落単位に分けて練習しても構いません。', reps: 1 },
  { title: '意味を確定させる', body: 'わからない語・構文を辞書や解説で解決し、全体の大意をつかみます（「語をタップで意味」がオンなら、本文の語をタップするとその語の意味と発音を確かめられます）。長い文は「構文図」で何と何が並列かを確かめます。「日本語」の「難しい語の意味」「タップで区切りの訳」「全文訳」はこの段階で使い、音読に入る前に「なし」に戻します（訳を見ながら読むと英語の処理が置き換わりやすいため、という設計上の判断です）。意味が取れないまま声に出しても、文字を音にしているだけになりがちです。', reps: 1 },
  { title: 'お手本を聞きながら目で追う', body: '「お手本を聞く」で区切りごとに再生し、色の付いたまとまりを目で追います。意味がすっと入らない所は「？ わかりにくい」で印をつけ、「一時停止」して確かめてから再開します（印の所は「印の所だけ続けて聞く」で聞き直せます）。端末の合成音声なので、発音の細部よりまとまりと文の流れの確認に使います。', reps: 2 },
  { title: '区切りあり音読', body: '1区切りずつ、意味を前から順に取りながら声に出します。区切りで短く間をとり、文末で声を下げます。つかえた箇所は区切りの後ろの小さな「？」を押して印をつけ、その区切りだけ読み直します。', reps: 2 },
  { title: '大きな区切りだけで音読', body: '表示を「大きな区切りだけ」に切り替え、節の切れ目だけを頼りに読みます。', reps: 1 },
  { title: '区切りなしで仕上げ', body: '表示を「なし」にして計測しながら読みます。読み終えたら、意味・正確さ・まとまりを自己評価し、本文を見ずに要旨を1〜2文で書きます。', reps: 2 },
  { title: '数日後にもう一度', body: '同じ英文を「区切りなし」で読み直し、記録を比べます。ときどき初見の英文も黙読して、理解を保ったまま読めるかを確かめます。', reps: 0 },
];

export const EVIDENCE = `
<p>この練習手順は、次の研究を参考に組み立てた<strong>設計上の判断</strong>です。研究の対象や条件は日本の高校生の入試長文とは異なることが多いため、限界も併記します。</p>
<ul>
<li><strong>反復読み（repeated reading）</strong>: 英語母語の5〜18歳を対象にした18研究のメタ分析で、流暢さ・理解ともに中程度以上の効果（Therrien, 2004）。ただし効果の多くは練習した文章上のもので、新しい文章への転移は小さい。モデル音声つき・フィードバックつきが有効で、1回の練習で読む回数は最大4回程度が目安とされます（Therrien &amp; Kubina, 2006）。<br>
<a href="https://apps.asha.org/EvidenceMaps/Articles/ArticleSummary/903ec865-92fd-4ca5-9cea-8534b161420a">Therrien 2004 要旨</a> · <a href="https://centralreach.com/wp-content/uploads/2019/04/2007-Therrien-and-Kubina.pdf">Therrien &amp; Kubina 2006</a></li>
<li><strong>補助つき（お手本あり）の読み</strong>は補助なしより効果的と考えられる一方、繰り返すこと自体より「フィードバックのある練習」が本質という指摘もあります（Kuhn &amp; Stahl, 2003 ほか）。対象は主に英語母語の児童。<br><a href="https://scholarworks.gsu.edu/psych_facpub/162">Kuhn &amp; Stahl 2003</a></li>
<li><strong>日本の大学生（EFL）</strong>: 黙読→3〜5語ごとのスラッシュ入り文章でチャンク単位の模倣音読→ペアで音読、という手順を1学期間行い、理解を保ったまま読む速さが伸びた（Shimono, 2018, 55名, 準実験、時間制限つき読みだけの群との差はなし）。<br><a href="https://files.eric.ed.gov/fulltext/EJ1176224.pdf">Shimono 2018</a> · <a href="https://nflrc.hawaii.edu/rfl/item/276">Chang &amp; Millett 2013（13名、未練習の文章にも伸び）</a></li>
<li><strong>区切りの位置</strong>: 意味のまとまりを無視して切った文章は、中級の日本人大学生の理解と読みの滑らかさを損ないました（Yamashita &amp; Ichikawa, 2010, 48名, 1回の実験）。そのため、区切りは等間隔ではなく句・節の切れ目に置きます。高校2年生へのチャンク提示訓練では統語処理の伸びが見られたものの、対照群との差は有意ではありませんでした（Kosaka, 2023, 56名, 4週間）。<br><a href="https://files.eric.ed.gov/fulltext/EJ901547.pdf">Yamashita &amp; Ichikawa 2010</a> · <a href="https://files.eric.ed.gov/fulltext/EJ1399504.pdf">Kosaka 2023</a></li>
<li><strong>区切りを外していく段階</strong>: 区切りを段階的に外すことで普通の文章へ移行できるかを直接検証した研究は見つかりませんでした。この手順の「区切りあり→大きな区切りだけ→なし」は仮説的な設計です。</li>
<li><strong>速さだけを成績にしない</strong>: 小学生250名の研究では、読解を説明したのは単語の正確さとプロソディ（まとまり・抑揚）で、速さは有意な予測因子ではありませんでした（Paige et al., 2017）。成人の英語学習者149名の研究では、日本語母語者の読解をプロソディが予測しました（Jiang, 2016, 相関研究・下位集団は少人数）。流暢さの指導が速さの競争になることへの批判もあります（Rasinski, 2012）。<br><a href="https://www.waxmann.com/en/journal/Journal-for-Educational-Research-Online-JERO-/artikel/Is-prosodic-reading-a-strategy-for-comprehension-ART102909">Paige et al. 2017</a> · <a href="https://readingmatrix.com/files/15-47d6ye21.pdf">Jiang 2016</a> · <a href="https://www.weschools.org/Downloads/Reading%20Fluency%20Article%20Rasinski.pdf">Rasinski 2012</a></li>
<li><strong>自己評価の観点</strong>は、多次元流暢性尺度（MFS: 表現・区切り・滑らかさ・速さ）を参考に、意味・正確さ・まとまりの3観点に独自の文言で簡略化しています。<a href="https://dyslexiahelp.umich.edu/professionals/dyslexia-and-intervention/reading-fluency/multidimensional-fluency-scale/">MFSの構成</a></li>
</ul>
<p>日本の高校生を対象にした統制実験、最適な反復回数、シャドーイングの上乗せ効果については、まだ結論が出ていません。</p>`;
