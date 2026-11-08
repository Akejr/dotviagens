// Blog articles (pt-AO). Edit here, then run: node scripts/build-blog.mjs
// The build writes public/blog/*.html and public/sitemap.xml and refuses dashes (— or –) in the text.
// faq: shown on the page and copied to the FAQPage data, so both always match.

export const articles = [
  {
    slug: 'passagens-aereas-baratas-em-angola',
    title: 'Passagens aéreas baratas em Angola: 9 dicas para pagar menos',
    seoTitle: 'Passagens aéreas baratas em Angola: 9 dicas | DOT Viagens',
    description: 'Como encontrar passagens aéreas baratas a partir de Angola: datas flexíveis, calendário de preços, escalas, antecedência e pagamento em kwanzas sem surpresas.',
    crumb: 'Passagens aéreas baratas',
    category: 'Dicas',
    published: '2026-11-08',
    excerpt: 'Datas flexíveis, calendário de preços, escalas e antecedência: escolhas simples que baixam o preço da mesma viagem.',
    lead: 'O preço de uma passagem muda com a data, a hora, a companhia e a procura. Com algumas escolhas simples, consegues pagar menos pela mesma viagem.',
    cover: { src: '/assets/hero/angola-mountains.jpg', srcset: '/assets/hero/angola-mountains-960.jpg 960w, /assets/hero/angola-mountains.jpg 1280w', width: 1280, height: 853, alt: 'Estrada sinuosa da Serra da Leba, na Huíla' },
    cta: { title: 'Encontra o dia mais barato', text: 'Escolhe o destino e vê o preço de cada dia no calendário, já em kwanzas.', label: 'Ver o calendário de preços', href: '/#pesquisa' },
    body: `
<h2>1. Começa pelo calendário de preços</h2>
<p>Antes de fixares as datas, abre o calendário da pesquisa. Por baixo de cada dia aparece o preço indicativo mais baixo, já em kwanzas, e os dias mais baratos do mês ficam a verde. Muitas vezes, mudar a partida um ou dois dias faz uma diferença grande no total.</p>
<p>Na ida e volta, o calendário do regresso mostra o total da viagem para cada data de volta, com a ida que escolheste. Assim comparas o preço final da viagem inteira, e não só o de um trajecto.</p>
<h2>2. Compara os dias vizinhos nos resultados</h2>
<p>Depois de pesquisar, os resultados mostram os dias anteriores e seguintes com o menor preço encontrado para cada um. É a forma mais rápida de ver se compensa sair na véspera ou no dia seguinte.</p>
<h2>3. Sê flexível com o dia da semana</h2>
<p>Em muitas rotas, os voos a meio da semana custam menos do que à sexta-feira ou ao domingo, quando viaja mais gente. Não é uma regra fixa, por isso confirma sempre no calendário.</p>
<h2>4. Compra com antecedência</h2>
<p>Em geral, os lugares mais baratos de cada voo são os primeiros a esgotar. Para as épocas de muita procura, como o Natal, o fim do ano, a Páscoa e as férias de Julho e Agosto, vale a pena comprar com semanas ou meses de antecedência.</p>
<h2>5. Considera um voo com escala</h2>
<p>O voo directo é mais rápido e confortável, mas uma ligação com escala pode custar bem menos. Antes de escolheres, vê a duração total e o tempo de cada conexão. Uma escala muito curta deixa pouca margem e uma muito longa pode obrigar-te a passar a noite no aeroporto.</p>
<h2>6. Compara companhias e horários</h2>
<p>A mesma rota pode ter preços muito diferentes conforme a companhia e a hora do voo. Usa os filtros de companhias e de voos directos para comparar as opções da data que te interessa.</p>
<h2>7. Compra a ida e a volta juntas</h2>
<p>Quando já sabes a data de regresso, compra a ida e a volta na mesma pesquisa. Muitas vezes o total fica mais barato do que dois bilhetes só de ida e tens o regresso garantido desde o início.</p>
<h2>8. Vê se há outro aeroporto no destino</h2>
<p>Algumas regiões têm mais do que um aeroporto. Para Portugal, por exemplo, compara Lisboa e Porto. Em certas datas, a diferença de preço compensa a viagem de comboio ou de autocarro até ao destino final.</p>
<h2>9. Conta com o preço final</h2>
<p>Um preço baixo só é bom se não houver surpresas. Na DOT Viagens, o valor que vês já é o total em kwanzas para todos os passageiros, com taxas incluídas. Antes de pagares, o preço é confirmado e fica garantido durante 15 minutos.</p>
<aside class="post-tip"><strong>Bagagem</strong><p>As regras de bagagem mudam de companhia para companhia. Se precisares de levar malas de porão, pergunta-nos no WhatsApp antes de pagar.</p></aside>
<p>Já sabes o destino? Lê também <a href="/blog/bilhetes-de-aviao-baratos">como escolher entre ida e volta, só ida e voos com escala</a> e <a href="/blog/como-pagar-passagens-aereas-em-kwanzas">como pagar a passagem em kwanzas</a>.</p>`,
    faq: [
      { q: 'Qual é o melhor dia para comprar passagens baratas?', a: 'Não há um dia certo para todas as rotas. O mais seguro é comparar datas no calendário de preços e nos dias vizinhos dos resultados, e comprar com antecedência nas épocas de muita procura.' },
      { q: 'Os preços do calendário são finais?', a: 'São indicativos. O preço final confirma-se na pesquisa e antes do pagamento, já em kwanzas e com taxas incluídas.' },
      { q: 'Um voo com escala é sempre mais barato?', a: 'Nem sempre, mas muitas vezes é. Compara o preço com a duração total da viagem e com o tempo de cada conexão.' },
    ],
  },
  {
    slug: 'como-pagar-passagens-aereas-em-kwanzas',
    title: 'Como pagar passagens aéreas em kwanzas',
    seoTitle: 'Como pagar passagens aéreas em kwanzas | DOT Viagens',
    description: 'Guia para pagar passagens e bilhetes de avião em kwanzas: Multicaixa Express, referência bancária ou pagamento manual pelo WhatsApp, com preço final e factura.',
    crumb: 'Pagar passagens em kwanzas',
    category: 'Pagamentos',
    published: '2026-11-08',
    excerpt: 'Multicaixa Express, referência bancária ou pagamento manual pelo WhatsApp. Sem cartão internacional e com o preço final à vista.',
    lead: 'Na DOT Viagens compras passagens para o mundo inteiro e pagas em kwanzas, sem cartão internacional. Vê como funciona cada forma de pagamento e o que acontece depois.',
    cover: { art: true, src: '/assets/boarding-tickets-900.png', webp: '/assets/boarding-tickets-900.webp', width: 900, height: 460, alt: 'Bilhetes de embarque DOT Viagens de Angola para o mundo' },
    ogImage: { src: '/assets/og-dot-viagens.jpg', width: 1200, height: 630 },
    cta: { title: 'Pronto para a próxima viagem?', text: 'Compara voos de Luanda para o mundo e paga em kwanzas.', label: 'Pesquisar voos', href: '/#pesquisa' },
    body: `
<h2>Porque pagar a passagem em kwanzas</h2>
<p>Muitos sites de viagens só aceitam cartões internacionais e mostram os preços em dólares ou em euros. Na DOT Viagens vês o preço final em kwanzas desde a primeira pesquisa e pagas com os meios que já usas em Angola. Não precisas de cartão Visa ou Mastercard, nem de fazer contas ao câmbio.</p>
<p>O valor que aparece é o total para todos os passageiros, com taxas incluídas. Antes de pagares, o preço é confirmado e fica garantido durante 15 minutos.</p>
<h2>Da pesquisa ao bilhete, em quatro passos</h2>
<ol class="post-steps">
<li><strong>Pesquisa e escolhe o voo.</strong> Indica a origem, o destino e as datas. Compara preços, horários, escalas e companhias e escolhe a ida e a volta.</li>
<li><strong>Confirma o teu telemóvel.</strong> Enviamos um código por SMS. É com esse número que depois acompanhas a viagem em Minhas viagens.</li>
<li><strong>Indica os passageiros.</strong> Escreve os nomes e os dados do passaporte exactamente como aparecem no documento.</li>
<li><strong>Escolhe como pagar.</strong> Referência bancária e Multicaixa Express, na página segura da Wiza, ou pagamento manual com a equipa DOT pelo WhatsApp.</li>
</ol>
<h2>As formas de pagamento</h2>
<h3>Multicaixa Express</h3>
<p>Na página de pagamento escolhes Multicaixa Express, indicas o número de telemóvel associado à app e autorizas o pagamento na aplicação. A confirmação chega em poucos segundos e a página da compra actualiza-se sozinha.</p>
<h3>Referência bancária</h3>
<p>Se preferires, geras uma referência com entidade e valor e pagas no ATM, no Multicaixa Express ou no internet banking do teu banco, na opção de pagamento por referência. Quando o pagamento é confirmado, avisamos-te por SMS.</p>
<p>A reserva espera pelo pagamento até 72 horas, mas convém pagar logo: até lá, os lugares e os preços dos voos podem mudar.</p>
<h3>Pagamento manual pelo WhatsApp</h3>
<p>Também podes escolher pagamento manual. Guardamos a tua reserva e abrimos o WhatsApp da DOT com os dados do voo já escritos na mensagem. A equipa responde e combina contigo como pagar o total. Depois de recebermos o pagamento, confirmamos a reserva e recebes o SMS.</p>
<aside class="post-tip"><strong>E os cartões Visa e Mastercard?</strong><p>De momento, os pagamentos com cartão estão indisponíveis. Usa o Multicaixa Express, a referência bancária ou o pagamento manual.</p></aside>
<h2>O que acontece depois de pagar</h2>
<p>Um pagamento confirmado ainda não é um bilhete emitido. Depois da confirmação, a equipa DOT emite o bilhete na companhia aérea e avisa-te por SMS logo que estiver pronto, com o código da reserva (PNR).</p>
<ul>
<li>Recebes um SMS quando o pagamento é confirmado.</li>
<li>Recebes outro SMS, com o código da reserva, quando o bilhete é emitido.</li>
<li>Em Minhas viagens encontras o bilhete, o estado do pagamento, o itinerário e a factura, com o teu número de telemóvel.</li>
<li>A factura-recibo é certificada pela AGT. Podes pedi-la com o NIF de uma empresa ou com o teu; sem NIF, sai em nome de Consumidor Final.</li>
</ul>
<h2>Antes de pagar, confirma</h2>
<ul>
<li>Os nomes e os apelidos de cada passageiro, tal como estão no passaporte.</li>
<li>A validade do passaporte. Muitos países pedem que seja válido vários meses depois da viagem.</li>
<li>As datas e os horários, que são sempre locais de cada aeroporto. A chegada pode ser no dia seguinte.</li>
</ul>
<p>Para escolher a forma de pagamento que te dá mais jeito, vê <a href="/blog/multicaixa-express-ou-referencia">Multicaixa Express, referência ou WhatsApp: qual escolher</a>.</p>`,
    faq: [
      { q: 'Preciso de cartão internacional para comprar uma passagem?', a: 'Não. Pagas em kwanzas com Multicaixa Express, com referência bancária no ATM ou no internet banking, ou com pagamento manual pelo WhatsApp.' },
      { q: 'Quanto tempo tenho para pagar por referência?', a: 'A reserva fica à espera do pagamento até 72 horas. Recomendamos pagar o quanto antes, porque a disponibilidade dos voos pode mudar. Depois desse prazo, faz uma nova pesquisa para ver os preços actuais.' },
      { q: 'O valor pode mudar depois de começar a compra?', a: 'O preço final em kwanzas é calculado antes do pagamento e fica garantido durante 15 minutos. Se o tempo passar, a página mostra o preço actualizado antes de pagares.' },
      { q: 'Recebo factura da compra?', a: 'Sim. Depois do pagamento, a factura-recibo certificada pela AGT fica disponível em Minhas viagens. Podes pedir factura com NIF de empresa ou particular.' },
    ],
  },
  {
    slug: 'bilhetes-de-aviao-baratos',
    title: 'Bilhetes de avião baratos: ida e volta, só ida ou com escala?',
    seoTitle: 'Bilhetes de avião baratos: ida e volta ou só ida | DOT Viagens',
    description: 'Bilhetes de avião baratos a partir de Luanda: quando compensa a ida e volta, quando comprar só ida e como avaliar um voo com escala antes de pagar em kwanzas.',
    crumb: 'Bilhetes de avião baratos',
    category: 'Dicas',
    published: '2026-11-08',
    excerpt: 'Cada escolha mexe no preço do bilhete. Vê quando compensa a ida e volta, quando faz sentido só ida e como avaliar uma escala.',
    lead: 'Ida e volta, só ida, directo ou com escala. Cada escolha mexe no preço do bilhete. Vê o que considerar antes de decidir.',
    cover: { src: '/assets/dubai.jpg', width: 800, height: 533, alt: 'Arranha-céus do Dubai ao pôr do sol' },
    cta: { title: 'Compara as opções da tua data', text: 'Vê os voos directos e com escala, lado a lado, com o preço final em kwanzas.', label: 'Comparar voos', href: '/#pesquisa' },
    body: `
<h2>Ida e volta: o total da viagem</h2>
<p>Quando pesquisas ida e volta, o preço que aparece é o total da viagem completa, para todos os adultos. Primeiro escolhes a ida e depois vês as voltas compatíveis, cada uma com o novo total. Não somes o preço da ida ao da volta: o valor da volta já é o da viagem inteira.</p>
<p>Comprar as duas viagens juntas costuma ficar mais barato do que dois bilhetes separados e deixa o regresso marcado desde o início.</p>
<h2>Só ida: quando faz sentido</h2>
<p>A pesquisa só ida é útil quando ainda não sabes quando voltas, quando vais estudar ou trabalhar fora, ou quando o regresso é por outra cidade. Em algumas rotas, um bilhete só de ida custa quase o mesmo que a ida e volta. Compara as duas opções antes de decidir.</p>
<h2>Directo ou com escala</h2>
<p>O voo directo poupa horas e evita o risco de perder uma ligação. O voo com escala pode ser bastante mais barato, sobretudo para destinos sem ligação directa a Luanda. Para avaliar uma escala, olha para três coisas:</p>
<ul>
<li><strong>Duração total.</strong> Uma poupança pequena pode não compensar muitas horas a mais de viagem.</li>
<li><strong>Tempo de conexão.</strong> Ao abrir o percurso vês quanto tempo esperas e em que aeroporto, por exemplo, conexão de 2 horas e 25 minutos em Casablanca.</li>
<li><strong>Escalas de madrugada.</strong> Uma ligação durante a noite pode obrigar-te a esperar muitas horas no aeroporto.</li>
</ul>
<aside class="post-tip"><strong>Documentos na escala</strong><p>Alguns países pedem visto de trânsito, mesmo que não saias do aeroporto. Confirma as regras do país da escala antes de comprar.</p></aside>
<h2>Tarifa mais barata, regras mais apertadas</h2>
<p>Em geral, as tarifas mais baratas têm mais restrições. Alterar a data ou cancelar pode custar mais, ou não ser possível, e a bagagem de porão pode não estar incluída. Se precisares de flexibilidade ou de levar malas, pergunta-nos no WhatsApp antes de pagar.</p>
<h2>A data também mexe no preço</h2>
<p>O preço muda de dia para dia. No calendário da pesquisa vês o valor indicativo de cada dia e, nos resultados, comparas os dias vizinhos. Se a tua data for flexível, experimenta sair um ou dois dias antes ou depois.</p>
<h2>Antes de pagar</h2>
<ul>
<li>Revê os horários, que são locais de cada aeroporto, e o dia de chegada, que pode ser o seguinte.</li>
<li>Confirma os nomes dos passageiros tal como estão no passaporte.</li>
<li>Lembra-te de que o preço final em kwanzas já inclui as taxas e é para todos os adultos.</li>
</ul>
<p>Mais formas de poupar estão nas <a href="/blog/passagens-aereas-baratas-em-angola">9 dicas para passagens aéreas baratas em Angola</a>.</p>`,
    faq: [
      { q: 'O preço da volta soma-se ao da ida?', a: 'Não. Na ida e volta, o valor da volta que escolhes já é o total da viagem completa.' },
      { q: 'Posso comprar só a ida e a volta mais tarde?', a: 'Podes, com duas compras só de ida. Compara antes com a ida e volta, que muitas vezes sai mais barata.' },
      { q: 'Como sei quanto tempo dura a escala?', a: 'Ao abrir o percurso de cada voo vês a hora de cada trajecto, o aeroporto da conexão e o tempo de espera.' },
    ],
  },
  {
    slug: 'multicaixa-express-ou-referencia',
    title: 'Multicaixa Express, referência ou WhatsApp: como pagar o teu bilhete',
    seoTitle: 'Multicaixa Express ou referência: pagar bilhetes | DOT Viagens',
    description: 'Multicaixa Express, referência bancária ou WhatsApp: compara as formas de pagar bilhetes de avião em kwanzas na DOT Viagens e escolhe a melhor para ti.',
    crumb: 'Multicaixa Express ou referência',
    category: 'Pagamentos',
    published: '2026-11-08',
    excerpt: 'O total é sempre o mesmo. Muda a rapidez da confirmação e o sítio onde pagas. Compara as três formas.',
    lead: 'Há três formas de pagar a tua passagem em kwanzas na DOT Viagens. O total é sempre o mesmo; muda a rapidez da confirmação e o sítio onde pagas.',
    cover: { src: '/assets/hero/angola-city.jpg', srcset: '/assets/hero/angola-city-960.jpg 960w, /assets/hero/angola-city.jpg 1920w', width: 1920, height: 1183, alt: 'Baía e Marginal de Luanda iluminadas ao anoitecer' },
    cta: { title: 'Escolhe a viagem e depois a forma de pagar', text: 'No fim da compra escolhes Multicaixa Express, referência ou WhatsApp.', label: 'Pesquisar voos', href: '/#pesquisa' },
    body: `
<h2>Multicaixa Express: confirmação na hora</h2>
<p>É a opção mais rápida. Na página segura da Wiza escolhes Multicaixa Express e indicas o número associado à app. Recebes o pedido no telemóvel, confirmas e, em poucos segundos, a compra fica paga.</p>
<ul>
<li>Precisas da app Multicaixa Express activa, com um cartão associado.</li>
<li>Confirmas o pagamento na notificação da app ou nas operações por autorizar.</li>
<li>Mantém a página da compra aberta até aparecer a confirmação.</li>
</ul>
<h2>Referência bancária: pagas quando e onde quiseres</h2>
<p>Se não usas o Multicaixa Express, ou preferes pagar mais tarde, gera uma referência. Recebes a entidade, a referência e o valor e pagas no ATM, no Multicaixa Express ou no internet banking, na opção de pagamento por referência.</p>
<ul>
<li>A confirmação pode demorar mais do que no Multicaixa Express. Avisamos-te por SMS assim que chegar.</li>
<li>A reserva espera pelo pagamento até 72 horas.</li>
<li>Paga o quanto antes: até ao pagamento, os lugares e os preços podem mudar.</li>
</ul>
<h2>Pagamento manual pelo WhatsApp</h2>
<p>Preferes falar com alguém? Escolhe pagamento manual. A reserva fica guardada e o WhatsApp da DOT abre com a mensagem pronta: a referência da reserva, os voos, os passageiros e o total. A equipa responde e combina contigo como pagar.</p>
<p>Depois de recebermos o pagamento, confirmamos a reserva e recebes o SMS. Se mudares de ideias, podes pagar com referência bancária ou Multicaixa Express na página da reserva, enquanto ela estiver à espera do pagamento.</p>
<h2>Se o pagamento não passar</h2>
<p>Acontece. O mais comum é a notificação não chegar à app, ou o número indicado não ser o que está associado ao Multicaixa Express. Nesses casos:</p>
<ul>
<li>Confirma que indicaste o número de telemóvel associado à app.</li>
<li>Abre a app e procura o pedido nas operações por autorizar.</li>
<li>Na página da reserva, usa Tentar novamente para iniciar um novo pagamento.</li>
<li>Se continuar sem passar, escolhe a referência bancária ou fala connosco no WhatsApp.</li>
</ul>
<p>Quando um pagamento não é concluído, nenhum valor é cobrado por essa tentativa.</p>
<h2>Qual escolher?</h2>
<div class="post-table-wrap"><table class="post-table">
<thead><tr><th>Forma de pagamento</th><th>Onde pagas</th><th>Confirmação</th></tr></thead>
<tbody>
<tr><td>Multicaixa Express</td><td>Na app, no telemóvel</td><td>Em poucos segundos</td></tr>
<tr><td>Referência bancária</td><td>ATM, Multicaixa Express ou internet banking</td><td>Pode demorar mais; avisamos por SMS</td></tr>
<tr><td>Pagamento manual</td><td>Como combinares no WhatsApp</td><td>Quando a equipa DOT recebe o pagamento</td></tr>
</tbody></table></div>
<aside class="post-tip"><strong>Cartões Visa e Mastercard</strong><p>De momento, os pagamentos com cartão estão indisponíveis.</p></aside>
<p>Queres ver o processo completo, da pesquisa ao bilhete? Lê <a href="/blog/como-pagar-passagens-aereas-em-kwanzas">como pagar passagens aéreas em kwanzas</a>.</p>`,
    faq: [
      { q: 'O preço muda conforme a forma de pagamento?', a: 'Não. O total em kwanzas é o mesmo nas três formas de pagamento.' },
      { q: 'Paguei por referência. Quando recebo a confirmação?', a: 'Assim que o pagamento é confirmado, recebes um SMS e o estado muda em Minhas viagens. Pode demorar mais do que no Multicaixa Express.' },
      { q: 'Posso mudar de pagamento manual para Multicaixa Express?', a: 'Podes. Na página da reserva, escolhe pagar com referência bancária ou Multicaixa Express enquanto a reserva estiver à espera do pagamento.' },
    ],
  },
  {
    slug: 'passagens-luanda-lisboa',
    title: 'Passagens de Luanda para Lisboa: o que saber antes de comprar',
    seoTitle: 'Passagens de Luanda para Lisboa: guia de compra | DOT Viagens',
    description: 'Passagens aéreas de Luanda para Lisboa: voos directos e com escala, épocas mais caras, documentos e como pagar em kwanzas com Multicaixa Express ou referência.',
    crumb: 'Luanda para Lisboa',
    category: 'Destinos',
    published: '2026-11-08',
    excerpt: 'Voos directos e com escala, épocas mais caras, Lisboa ou Porto e os documentos para viajar.',
    lead: 'Portugal é um dos destinos mais procurados a partir de Angola. Vê como comparar os voos para Lisboa, quando os preços sobem e o que preparar antes de comprar.',
    cover: { src: '/assets/lisboa.jpg', width: 800, height: 533, alt: 'Ribeira do Porto, com o casario colorido junto ao rio Douro' },
    cta: { title: 'Pesquisa voos para Lisboa', text: 'Vê os preços de cada dia no calendário e paga em kwanzas.', label: 'Pesquisar voos para Lisboa', href: '/?destino=LIS#pesquisa' },
    body: `
<h2>Voos directos e com escala</h2>
<p>Entre Luanda e Lisboa há voos directos, que costumam ser operados pela TAAG e pela TAP, e também ligações com escala noutras cidades. O directo é a forma mais rápida de chegar; com escala, a viagem demora mais, mas às vezes custa menos.</p>
<p>Na pesquisa da DOT, Luanda aparece com o código NBJ, do Aeroporto Internacional Dr. António Agostinho Neto, e Lisboa com LIS, o Aeroporto Humberto Delgado. Nos resultados vês todas as opções da data, com os horários, as companhias e o tempo de cada conexão.</p>
<h2>Quando os preços sobem</h2>
<p>A procura entre Angola e Portugal aumenta muito no Natal e no fim do ano, na Páscoa e nas férias de Verão, em Julho e Agosto. Nessas épocas, compra com a maior antecedência possível. Se tens datas flexíveis, usa o calendário de preços para encontrar os dias mais baratos do mês.</p>
<h2>Lisboa ou Porto?</h2>
<p>Se o teu destino final for o norte de Portugal, compara também os voos para o Porto (OPO), no Aeroporto Francisco Sá Carneiro. Em algumas datas a diferença de preço compensa; noutras, chegar a Lisboa e seguir de comboio é mais prático.</p>
<h2>Documentos para viajar</h2>
<ul>
<li><strong>Visto.</strong> Com passaporte angolano, a entrada em Portugal exige, em regra, visto Schengen. Trata dele com tempo e confirma os requisitos actuais no consulado ou no centro de vistos.</li>
<li><strong>Passaporte.</strong> Para o espaço Schengen, o passaporte tem de ser válido pelo menos três meses depois da data em que sais e ter sido emitido há menos de dez anos.</li>
<li><strong>Nomes.</strong> Na compra, escreve os nomes exactamente como no passaporte. É com esses dados que a DOT emite o bilhete.</li>
</ul>
<h2>Do aeroporto ao centro de Lisboa</h2>
<p>O Aeroporto Humberto Delgado fica perto do centro da cidade. A linha vermelha do metro liga o aeroporto à rede do metro de Lisboa e há também táxis, transporte por aplicação e autocarros.</p>
<aside class="post-tip"><strong>Diferença horária</strong><p>No Inverno, Lisboa está uma hora atrás de Luanda. No Verão, as duas cidades têm a mesma hora. Os horários dos voos aparecem sempre na hora local de cada aeroporto.</p></aside>
<h2>Como comprar e pagar em kwanzas</h2>
<p>Pesquisa Luanda para Lisboa, escolhe a ida e a volta e revê a viagem. Depois confirmas o teu telemóvel por SMS, indicas os passageiros e escolhes como pagar: referência bancária e Multicaixa Express, ou pagamento manual pelo WhatsApp. O preço que vês é o total em kwanzas, com taxas incluídas.</p>
<p>Antes de escolher as datas, vê as <a href="/blog/passagens-aereas-baratas-em-angola">dicas para pagar menos pela passagem</a>.</p>`,
    faq: [
      { q: 'Há voos directos de Luanda para Lisboa?', a: 'Sim, há voos directos nesta rota, além de ligações com escala. Na pesquisa vês as opções disponíveis para cada data.' },
      { q: 'Quando é mais caro voar para Lisboa?', a: 'Em geral, no Natal e no fim do ano, na Páscoa e nas férias de Julho e Agosto. Nessas épocas, compra com antecedência.' },
      { q: 'Preciso de visto para ir a Portugal?', a: 'Com passaporte angolano, em regra, sim: visto Schengen. Confirma sempre os requisitos actuais no consulado ou no centro de vistos.' },
    ],
  },
  {
    slug: 'passagens-luanda-sao-paulo',
    title: 'Passagens de Luanda para São Paulo: o que saber antes de comprar',
    seoTitle: 'Passagens de Luanda para São Paulo: guia | DOT Viagens',
    description: 'Passagens aéreas de Luanda para São Paulo: voos directos e com escala, diferença horária, documentos e como pagar em kwanzas com Multicaixa Express ou referência.',
    crumb: 'Luanda para São Paulo',
    category: 'Destinos',
    published: '2026-11-08',
    excerpt: 'Voos directos e com escala, diferença horária, épocas mais caras e documentos para o Brasil.',
    lead: 'Para quem sai de Angola, São Paulo é uma das principais portas de entrada no Brasil. Vê como escolher o voo, o que preparar e como pagar em kwanzas.',
    cover: { src: '/assets/saopaulo.jpg', width: 800, height: 600, alt: 'Avenida Paulista e prédios de São Paulo' },
    cta: { title: 'Pesquisa voos para São Paulo', text: 'Compara datas e companhias e paga a passagem em kwanzas.', label: 'Pesquisar voos para São Paulo', href: '/?destino=GRU#pesquisa' },
    body: `
<h2>Voos directos e com escala</h2>
<p>Entre Luanda e São Paulo há voos directos, que costumam ser operados pela TAAG, e várias ligações com escala, por exemplo em Lisboa, Adis Abeba, Casablanca ou no Dubai, conforme a data e a companhia.</p>
<p>Na pesquisa, São Paulo aparece com o código GRU, do Aeroporto Internacional de Guarulhos, o maior da cidade. Com escala, a viagem pode demorar muitas horas a mais, por isso compara sempre a duração total e o tempo de cada conexão.</p>
<h2>Diferença horária</h2>
<p>São Paulo está quatro horas atrás de Luanda durante todo o ano. Os horários dos voos aparecem sempre na hora local de cada aeroporto e a chegada pode ser no dia seguinte.</p>
<h2>Quando os preços sobem</h2>
<p>As épocas de mais procura costumam ser o fim do ano, as férias escolares e o Carnaval no Brasil. Se tiveres datas flexíveis, o calendário de preços mostra os dias mais baratos de cada mês.</p>
<h2>Documentos para viajar</h2>
<ul>
<li><strong>Visto.</strong> Confirma no Consulado do Brasil se precisas de visto para a tua viagem e trata do processo com tempo.</li>
<li><strong>Passaporte.</strong> Verifica a validade antes de comprar e escreve os nomes exactamente como no documento.</li>
<li><strong>Vacinas.</strong> Confirma se há vacinas exigidas ou recomendadas para a viagem, como a da febre amarela, e leva o boletim internacional de vacinação.</li>
</ul>
<h2>Do aeroporto à cidade</h2>
<p>O Aeroporto de Guarulhos fica fora do centro de São Paulo. Para chegares à cidade tens táxis, transporte por aplicação, autocarros que ligam o aeroporto a vários pontos da cidade e o comboio da linha 13 Jade. Conta com tempo: o trânsito em São Paulo pode ser intenso, sobretudo nas horas de ponta.</p>
<aside class="post-tip"><strong>Viagens longas</strong><p>Num voo com escala, vê se a conexão é de dia ou de madrugada e quanto tempo esperas. Uma escala bem escolhida torna a viagem muito mais tranquila.</p></aside>
<h2>Como comprar e pagar em kwanzas</h2>
<p>Pesquisa Luanda para São Paulo, compara as datas no calendário e escolhe a ida e a volta. Depois confirmas o telemóvel por SMS, indicas os passageiros e escolhes como pagar: referência bancária e Multicaixa Express, ou pagamento manual pelo WhatsApp. O preço final já está em kwanzas e inclui as taxas.</p>
<p>Para avaliar as escalas com calma, lê <a href="/blog/bilhetes-de-aviao-baratos">ida e volta, só ida ou com escala</a>.</p>`,
    faq: [
      { q: 'Há voos directos de Luanda para São Paulo?', a: 'Sim, há voos directos nesta rota, além de ligações com escala. Na pesquisa vês as opções disponíveis para cada data.' },
      { q: 'Qual é a diferença horária entre Luanda e São Paulo?', a: 'São Paulo está quatro horas atrás de Luanda durante todo o ano.' },
      { q: 'Posso pagar a passagem para o Brasil em kwanzas?', a: 'Sim. Na DOT Viagens pagas em kwanzas, com referência bancária, Multicaixa Express ou pagamento manual pelo WhatsApp.' },
    ],
  },
];

export const blog = {
  title: 'Dicas para viajar mais e pagar em kwanzas.',
  seoTitle: 'Blog DOT Viagens: passagens aéreas baratas e dicas de viagem',
  description: 'Dicas para encontrar passagens aéreas baratas em Angola, pagar bilhetes em kwanzas e preparar viagens de Luanda para Lisboa, São Paulo e o mundo.',
  lead: 'Como encontrar passagens aéreas baratas, pagar bilhetes em kwanzas e preparar a viagem a partir de Angola.',
};
