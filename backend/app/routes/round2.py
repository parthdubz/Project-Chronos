from fastapi import APIRouter
from pydantic import BaseModel

from ..services import round2_service as svc

router = APIRouter(prefix="/api/round2", tags=["Round 2"])


class TeamBody(BaseModel):
    team_id: int


class ChatBody(TeamBody):
    message: str


class SubmitBody(TeamBody):
    suspect: str  # a suspect's name or user id


@router.post("/start")
def start(body: TeamBody):
    return svc.start_round2(body.team_id)


@router.get("/progress")
def progress(team_id: int):
    return svc.get_progress(team_id)


@router.get("/files")
def get_files(team_id: int):
    return svc.list_files(team_id)


@router.get("/files/{file_id}")
def get_file(file_id: str, team_id: int):
    # 404 "File not found or access denied" for a locked or unknown file
    return svc.read_file(team_id, file_id)


@router.get("/suspects")
def get_suspects(team_id: int):
    return svc.list_suspects(team_id)


@router.post("/chat")
def chat(body: ChatBody):
    return svc.chat(body.team_id, body.message)


@router.get("/conversation")
def conversation(team_id: int):
    return svc.get_conversation(team_id)


@router.post("/submit")
def submit(body: SubmitBody):
    return svc.submit_culprit(body.team_id, body.suspect)
