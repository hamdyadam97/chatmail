import { PlaceholderPage } from '../../shared/components/PlaceholderPage';
import { ChatPage } from './ChatPage';

export const DirectMessages = () => <ChatPage type="dm" />;
export const GroupChats = () => <ChatPage type="group" />;
/** القنوات خارج نطاق عقد المراسلة الحالي — تبقى نائبة. */
export const Channels = () => <PlaceholderPage title="القنوات" />;

export const ChatPages = { DirectMessages, GroupChats, Channels };
