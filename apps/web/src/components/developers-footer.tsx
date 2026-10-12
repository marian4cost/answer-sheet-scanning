import Link from 'next/link';
import { UsersRound } from 'lucide-react';
import styles from './developers-footer.module.css';

export function DevelopersFooter() {
  return <footer>
    <div className={`shell ${styles.content}`}>
      <span>Instituto Federal de Sergipe - Campus Lagarto · {new Date().getFullYear()}</span>
      <Link href="/desenvolvedores" className={styles.link}>
        <UsersRound size={17} aria-hidden="true"/>
        Conhecer os desenvolvedores
      </Link>
    </div>
  </footer>;
}
