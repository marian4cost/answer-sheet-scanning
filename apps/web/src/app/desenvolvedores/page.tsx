import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft, ArrowUpRight, Braces, ChartNoAxesCombined, Code2, Github, Globe, Linkedin, ScanLine } from 'lucide-react';
import styles from './developers.module.css';

export const metadata: Metadata = {
  title: 'Desenvolvedores',
  description: 'Conheça Mariana da Costa Lisboa e Genisson Emilio dos Santos, desenvolvedores do SIRENIA, e explore seus portfólios e projetos.',
};

const developers = [
  {
    id: 'mariana',
    name: 'Mariana da Costa Lisboa',
    initials: 'ML',
    area: 'Análise de dados e visão computacional',
    description: 'Desenvolve projetos com Python, estatística e visualização de dados. Seu trabalho conecta análise de informações, pesquisa aplicada e reconhecimento de imagens.',
    technologies: ['Python', 'OpenCV', 'Estatística', 'Visualização de dados'],
    portfolio: 'https://marianaanalyst.mage.dev.br/',
    github: 'https://github.com/marian4cost',
    linkedin: 'https://www.linkedin.com/in/mariana-costa-a702aa281/',
    project: {
      name: 'VIPER',
      description: 'Detecção e reconhecimento de placas veiculares com visão computacional e OCR.',
      url: 'https://github.com/marian4cost/VIPER',
    },
    Icon: ChartNoAxesCombined,
  },
  {
    id: 'genisson',
    name: 'Genisson Emilio dos Santos',
    initials: 'GS',
    area: 'Desenvolvimento web e inteligência artificial',
    description: 'Desenvolve aplicações web e sistemas de gestão com JavaScript e TypeScript. Explora inteligência artificial, visão computacional e IoT em projetos de software e pesquisa.',
    technologies: ['TypeScript', 'Next.js', 'NestJS', 'Python'],
    portfolio: 'https://genissondev.mage.dev.br/',
    github: 'https://github.com/GenissonEmilio',
    linkedin: 'https://www.linkedin.com/in/genisson-emilio/',
    project: {
      name: 'Neural-bot',
      description: 'Projeto em Python dedicado ao estudo e à aplicação de redes neurais.',
      url: 'https://github.com/GenissonEmilio/Neural-bot',
    },
    Icon: Code2,
  },
];

export default function DevelopersPage() {
  return <div className={styles.page}>
    <Link href="/" className={styles.back}><ArrowLeft size={16} aria-hidden="true"/>Voltar ao SIRENIA</Link>

    <section className={styles.hero} aria-labelledby="developers-title">
      <div className={styles.heroCopy}>
        <span className={styles.eyebrow}>PESSOAS POR TRÁS DO PROJETO</span>
        <h1 id="developers-title">Conheça quem desenvolve o <span>SIRENIA.</span></h1>
        <p>Mariana e Genisson combinam análise de dados, desenvolvimento de software e inteligência artificial para apoiar a correção de simulados e o acompanhamento dos alunos.</p>
        <a className={styles.teamLink} href="#equipe">Conheça a equipe <ArrowUpRight size={17} aria-hidden="true"/></a>
      </div>
      <div className={styles.heroArtwork} aria-hidden="true">
        <div className={styles.artworkOrbit}/>
        <div className={styles.artworkIcon}><ChartNoAxesCombined size={27}/></div>
        <div className={styles.artworkCenter}><Braces size={39}/><span>SIRENIA</span></div>
        <div className={styles.artworkIcon}><ScanLine size={27}/></div>
        <span className={styles.artworkLabel}>DADOS · CÓDIGO · EDUCAÇÃO</span>
      </div>
    </section>

    <section id="equipe" aria-labelledby="team-title" className={styles.team}>
      <div className={styles.sectionHeading}>
        <div><span className={styles.sectionEyebrow}>NOSSA EQUIPE</span><h2 id="team-title">Dois olhares, um projeto em comum.</h2></div>
        <p>Explore os portfólios e conheça outros trabalhos dos desenvolvedores.</p>
      </div>

      <div className={styles.cards}>
        {developers.map(developer => <article className={`${styles.card} ${styles[developer.id]}`} key={developer.id} aria-labelledby={`${developer.id}-name`}>
          <div className={styles.identity}>
            <div className={styles.avatar} aria-hidden="true">{developer.initials}</div>
            <span className={styles.identityIcon} aria-hidden="true"><developer.Icon size={24}/></span>
          </div>
          <span className={styles.role}>DESENVOLVIMENTO DO SIRENIA</span>
          <h3 id={`${developer.id}-name`}>{developer.name}</h3>
          <p className={styles.area}>{developer.area}</p>
          <p className={styles.description}>{developer.description}</p>
          <ul className={styles.technologies} aria-label={`Áreas e tecnologias de ${developer.name}`}>
            {developer.technologies.map(technology => <li key={technology}>{technology}</li>)}
          </ul>

          <div className={styles.project}>
            <span className={styles.projectLabel}>OUTRO PROJETO PARA CONHECER</span>
            <a href={developer.project.url} target="_blank" rel="noopener noreferrer" aria-label={`Conhecer ${developer.project.name} no GitHub, em nova aba`}>
              {developer.project.name}<ArrowUpRight size={17} aria-hidden="true"/>
            </a>
            <p>{developer.project.description}</p>
          </div>

          <a className={styles.portfolio} href={developer.portfolio} target="_blank" rel="noopener noreferrer" aria-label={`Ver portfólio de ${developer.name}, em nova aba`}>
            <Globe size={18} aria-hidden="true"/>Ver portfólio<ArrowUpRight size={17} aria-hidden="true"/>
          </a>
          <div className={styles.socials}>
            <a href={developer.github} target="_blank" rel="noopener noreferrer" aria-label={`GitHub de ${developer.name}, em nova aba`}><Github size={17} aria-hidden="true"/>GitHub</a>
            <a href={developer.linkedin} target="_blank" rel="noopener noreferrer" aria-label={`LinkedIn de ${developer.name}, em nova aba`}><Linkedin size={17} aria-hidden="true"/>LinkedIn</a>
          </div>
        </article>)}
      </div>
    </section>

    <section className={styles.mission} aria-labelledby="mission-title">
      <span className={styles.missionIcon} aria-hidden="true"><ScanLine size={25}/></span>
      <div><h2 id="mission-title">Mais tempo para ensinar. Mais clareza para acompanhar.</h2><p>O SIRENIA reúne leitura de cartões de respostas, revisão pelo professor e desempenho por área em um só lugar. A tecnologia apoia a correção; o professor acompanha e revisa cada resultado.</p></div>
      <Link href="/" className={styles.returnLink}>Acessar o SIRENIA<ArrowUpRight size={17} aria-hidden="true"/></Link>
    </section>
    <p className={styles.sourceNote}>Apresentações baseadas nos portfólios e projetos públicos dos desenvolvedores. Os links externos abrem em uma nova aba.</p>
  </div>;
}
