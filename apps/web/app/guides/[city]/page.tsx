import { GuideClient } from "../../../components/GuideClient";
export default async function GuidePage({ params }: { params: Promise<{ city: string }> }) { const { city } = await params; return <GuideClient city={decodeURIComponent(city)} />; }
